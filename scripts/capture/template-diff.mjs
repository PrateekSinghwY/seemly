// Template pixel + style harness: STORY, TEAM and PLAYER pages, clone vs live espn.com.
//
//   node never_to_be_pushed/discovery/tools/template-diff.mjs [--only=story|team|player] [--slug=<slug>]
//
// Both sides are driven by the SAME Chrome (the pw-profile browser on CDP :9222, the only
// route to the US edition), at 1440x900 @2, light, third parties blocked (the capture list).
// Regions are located by DOM rect on each side independently, clipped from a full-page
// capture, and compared with the pixel-diff.mjs rule (any channel delta > 8). Pixels
// outside the overlap of two differently sized crops count as differing.
//
// Masks (region-relative, unioned across both sides): relative ages / timestamps, live
// score strip, ads + sponsored + partner (tickets) modules, video media, the Follow button
// state, the account control, and the recorded deliberate deviations (disabled links:
// text glyph boxes of [aria-disabled] / :disabled on the clone; byline mugshot + date).
// Ref-only content the clone deliberately drops (story-page-gaps: tweets, iframes,
// Editor's Picks, promo asides, in-body ads; the duplicated pinned feed item) is removed
// from the reference with display:none BEFORE capture so the rest lines up.
//
// Output: never_to_be_pushed/discovery/pixel-reports/templates/<template>/<slug>/<region>/
// {ref,clone,diff}.png + <slug>/report.json, and templates/SUMMARY.md.
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { BLOCKED_URLS } from '../lib/block-list.mjs';

const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo
const OUT = `${REPO}/never_to_be_pushed/discovery/pixel-reports/templates`;
const REF = 'https://www.espn.com';
const CLONE = process.env.CLONE_BASE || 'http://localhost:3000';
const THRESH = 8;               // same channel threshold as scripts/pixel-diff.mjs
const MATCH_PCT = 1;            // pixel-diff.mjs PASS: < 1% differing ...
const SIZE_TOL = 0.02;          // ... and crop areas within 2%
const FULL_CAP = 6000;          // CSS px of full-page captured
const REGION_CAP = 5000;        // CSS px max height per region crop
// The shared list, plus embeds only the story template carries.
const BLOCK = [...BLOCKED_URLS, '*taboola*', '*outbrain*', '*platform.twitter.com*'];

const PAGES = [
  ['story', 'nfl-49999213', '/nfl/story/_/id/49999213/week-3-seven-things-solak-thinks-baker-mayfield-patriots-chargers'],
  ['story', 'nfl-49998629', '/nfl/story/_/id/49998629/evaluating-32-nfl-team-surprise-trends-2026-first-two-weeks-real-mirage'],
  ['story', 'ncaaf-50009005', '/college-football/story/_/id/50009005/2026-college-football-playoff-top-10-games-georgia-oklahoma'],
  ['story', 'wnba-50000578', '/wnba/story/_/id/50000578/wnba-power-rankings-valkyries-lynx-fever-playoffs'],
  ['team', 'nfl-buf', '/nfl/team/_/name/buf/buffalo-bills'],
  ['team', 'nba-bos', '/nba/team/_/name/bos/boston-celtics'],
  ['team', 'ncaaf-145', '/college-football/team/_/id/145/ole-miss-rebels'],
  ['team', 'wnba-lv', '/wnba/team/_/name/lv/las-vegas-aces'],
  ['player', 'nfl-4362506', '/nfl/player/_/id/4362506/greg-rousseau'],
  ['player', 'nba-4065648', '/nba/player/_/id/4065648/jayson-tatum'],
  ['player', 'ncaaf-4911529', '/college-football/player/_/id/4911529/trinidad-chambliss'],
  ['player', 'wnba-3149391', '/wnba/player/_/id/3149391/aja-wilson'],
];

const arg = k => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const ONLY = arg('only'), SLUG = arg('slug'), SUMMARY_ONLY = process.argv.includes('--summary-only');

// ------------------------------------------------------------------ in-page collector
// Runs in the page. Returns regions [{name, box, title, masked?, maskReason?, masks[], els[]}]
// in page-absolute CSS px (scrollY = 0).
function collect({ side, template, phase }) {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const R = el => { const r = el.getBoundingClientRect(); return [r.x + scrollX, r.y + scrollY, r.width, r.height]; };
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const AGE = /^(\d+\s?[smhd]|\d+\s+(sec|min|minute|hour|day|week)s?\s+ago|(yesterday|just now))$/i;
  const DATE = /^(\w{3,9}\.? \d{1,2}, \d{4}(, \d{1,2}:\d{2} ?(AM|PM)( ET)?)?|\d{1,2}:\d{2} ?(AM|PM)( ET)?)$/i;
  const AGE_IN = /\b\d+\s?[smhd]\b|\b\d+\s+(minutes?|hours?|days?)\s+ago\b/gi;
  const textRects = el => { const out = []; const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { if (!n.nodeValue.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 0 && r.height > 0) out.push([r.x + scrollX, r.y + scrollY, r.width, r.height]); } return out; };

  // ---- global masks (page coords) with reasons
  const masks = [];
  const addMask = (box, why) => { if (box && box[2] > 0 && box[3] > 0) masks.push({ box, why }); };
  // relative ages & timestamps (live reference vs frozen seed; byline date format deviation)
  for (const el of $$('body *')) {
    if (!vis(el) || el.children.length > 2) continue;
    const t = clean(el.innerText);
    if (!t || t.length > 40) continue;
    if (AGE.test(t) || DATE.test(t)) {
      // the whole meta line: a "1d" vs "19h" width change shifts everything after it
      const par = el.parentElement; const line = par && clean(par.innerText).length < 80 && par.getBoundingClientRect().height < 30 ? par : el;
      const a = R(el), l = R(line); addMask([a[0], l[1], l[0] + l[2] - a[0], l[3]], 'age/timestamp'); }
  }
  for (const el of $$('.timestamp, time, .time-elapsed, span.timestamp, .contentItem__publishedDate')) if (vis(el)) addMask(R(el), 'age/timestamp');
  // Follow button (state gap) and account control (never recorded)
  for (const el of $$('button')) if (vis(el) && /^(\+\s*)?follow(ing)?$/i.test(clean(el.innerText))) addMask(R(el), 'follow-state');
  for (const el of $$('#global-header li.user, li.Nav__Primary__Menu__Item--User, .Nav__Primary__Menu__Item--User')) addMask(R(el), 'account-control');
  // videos: media boxes (poster + play button); captions outside the media box stay compared
  for (const el of $$('video, .video-play-button, figure.video .img-wrap, figure.video > div:first-child, [aria-label=play], [aria-label=Play]')) if (vis(el)) {
    const f = el.closest('figure') || el; addMask(R(f.querySelector('img') ? f : el), 'video'); }
  // ads / sponsored
  for (const el of $$('.sponsored-content, [id^=ad-slot], .ad-slot, [data-ad-slot], .ad-300, .ad-298, .ad-banner-wrapper')) if (vis(el)) addMask(R(el), 'ad');
  // deliberate disabled treatment on the clone (unserved-links-disabled, story-page-gaps, team-player-*)
  if (side === 'clone') for (const el of $$('[aria-disabled=true], button:disabled, .cursor-not-allowed')) {
    if (!vis(el)) continue; const r = R(el);
    if (r[2] * r[3] <= 400 * 60 && !el.querySelector('img')) addMask(r, 'disabled'); else textRects(el).forEach(b => addMask(b, 'disabled'));
  }

  // ---- regions
  const regions = [];
  const add = (name, el, extra = {}) => { if (!el || !vis(el)) return; regions.push({ name, box: R(el), ...extra, _el: el }); };
  const addBox = (name, box, extra = {}) => { if (box && box[2] > 0 && box[3] > 0) regions.push({ name, box, ...extra }); };
  const union = els => { const bs = els.filter(vis).map(R); if (!bs.length) return null;
    const x0 = Math.min(...bs.map(b => b[0])), y0 = Math.min(...bs.map(b => b[1]));
    const x1 = Math.max(...bs.map(b => b[0] + b[2])), y1 = Math.max(...bs.map(b => b[1] + b[3])); return [x0, y0, x1 - x0, y1 - y0]; };
  const titleOf = m => { const h = m.querySelector('h1,h2,h3,header,[class*=Title]'); const t = clean(h && h.innerText).split(' | ')[0]; return t.slice(0, 70); };
  const keyOf = t => clean(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  const topmost = (root, sel) => $$(sel, root).filter(m => { if (!vis(m) || m.getBoundingClientRect().height < 20) return false;
    const anc = m.parentElement.closest(sel); return !anc || anc === root || !root.contains(anc); });
  const modulesOf = (col) => {
    const sel = 'section, article, .sponsored-content';
    const out = [];
    const expand = m => { const inner = topmost(m, sel).filter(x => x !== m && m.contains(x));
      return inner.length >= 2 ? inner.flatMap(expand) : [m]; };
    for (const ch of col.children) {
      if (!vis(ch)) continue;
      if (ch.matches(sel)) { out.push(...expand(ch)); continue; }
      const inner = topmost(ch, sel);
      if (inner.length) out.push(...inner.flatMap(expand)); else if (ch.getBoundingClientRect().height >= 20) out.push(ch);
    }
    return out;
  };

  if (phase === 'feed' && template === 'story') {
    const items = side === 'ref' ? $$('#news-feed .news-feed-item[data-id]') : $$('[data-story-page] nav li[data-id]');
    const seen = new Set();
    items.forEach((it, i) => { const id = it.getAttribute('data-id'); if (seen.has(id) || !vis(it)) return; seen.add(id);
      add(`feed-item/${id}`, it, { title: clean((it.querySelector('a') || it).innerText).slice(0, 60), order: i, family: 'feed-item' }); });
  } else if (template === 'story') {
    if (side === 'ref') {
      add('global-nav', $('#global-nav'));
      add('league-bar', $('#global-nav-secondary'));
      add('news-feed', $('#news-feed-content') || $('#news-feed'));
      const art = $('#article-feed article.article'); add('article', art, { family: 'article' });
      const c = art && $(':scope > .container', art);
      if (c) {
        add('article-header', $(':scope > header.article-header', c));
        add('hero', $(':scope > figure', c));
        const body = $(':scope > .article-body', c);
        add('byline', body && $(':scope > .article-meta', body));
        add('reactions', body && $(':scope > .content-reactions', body));
        if (body) regions.push(...sections(flatBody(body).filter(e => !e.matches('.article-meta, .content-reactions') && vis(e))));
        add('article-footer', $(':scope > footer', c) || $('footer.article-footer', art));
      }
    } else {
      const hdr = $('header.sticky'); add('global-nav', hdr && $('nav.espn-nav', hdr));
      add('league-bar', $('[data-module=league-nav]'));
      add('news-feed', $('[data-story-page] nav'));
      const art = $('article[data-story-id]'); add('article', art, { family: 'article' });
      const inner = art && art.firstElementChild;
      if (inner) {
        const kids = [...inner.children];
        add('article-header', kids.find(k => k.tagName === 'HEADER'));
        add('hero', kids.find(k => k.querySelector('figure') && !k.querySelector('p')));
        add('byline', kids.find(k => k.querySelector('time') || /border-b/.test(k.className)));
        add('reactions', kids.find(k => k.querySelector('button') && !k.querySelector('p, figure')));
        const body = kids.find(k => k.querySelector('p'));
        if (body) regions.push(...sections(flatBody(body).filter(vis)));
        add('article-footer', kids.find(k => k.tagName === 'FOOTER'));
      }
    }
  } else {
    // fitt team / player
    if (side === 'ref') {
      add('scoreboard', $('.HeaderScoreboardWrapper'), { masked: true, maskReason: 'live score strip' });
      add('global-nav', $('.Site__Header'));
      add('band', $('.ClubhouseHeader, .PlayerHeader'));
      add('tabs', $('nav.Nav__Secondary'));
    } else {
      add('scoreboard', $('[data-module=scores-strip]'), { masked: true, maskReason: 'live score strip' });
      const hdr = $('header.sticky'); add('global-nav', hdr);
      const pg = $('[data-clubhouse-page]');
      add('band', pg && pg.firstElementChild);
      add('tabs', pg && $('nav[aria-label]', pg));
    }
    const cols = side === 'ref'
      ? $$('.layout.is-clubhouse > .layout__column, .PageLayout.page-container > .PageLayout__LeftAside, .PageLayout.page-container > .PageLayout__Main, .PageLayout.page-container > .PageLayout__RightAside')
      : [...($('[data-clubhouse-page] .flex.justify-center')?.children || [])];
    cols.slice(0, 3).forEach((col, ci) => {
      const cname = ['left', 'main', 'right'][ci];
      const mods = modulesOf(col);
      const ub = union(mods); if (ub) addBox(`col-${cname}`, ub, { family: 'column' });
      mods.forEach((m, mi) => {
        const t = titleOf(m);
        const feed = m.tagName === 'ARTICLE' || /contentItem/.test(m.className);
        let title = t;
        if (feed) { const hs = [...m.querySelectorAll('h1,h2,h3,[class*=title]')].map(h => clean(h.innerText)).sort((a, b) => b.length - a.length); title = (hs[0] || t).slice(0, 70); }
        const partner = /ticket|vivid/i.test(t + ' ' + (m.id || ''));
        const ad = m.matches('.sponsored-content') || !!m.querySelector('[data-ad-slot]') && !t;
        add(`${cname}/${feed ? 'feed/' : ''}${keyOf(title) || 'untitled-' + mi}`, m, { title, order: mi, family: `${cname}-${feed ? 'feed-card' : 'module'}`,
          ...(partner ? { masked: true, maskReason: 'partner module (team-player-partner-modules)' } : {}),
          ...(ad ? { masked: true, maskReason: 'ad' } : {}) });
      });
    });
    const foot = side === 'ref' ? $('section.PageFooter') : $$('footer').filter(f => f.getBoundingClientRect().width >= 1000 && getComputedStyle(f).position !== 'fixed').pop()?.firstElementChild;
    add('page-footer', foot);
  }

  function flatBody(el) { const BLOCKS = /^(P|H[1-6]|UL|OL|HR|BLOCKQUOTE|FIGURE|IMG|ASIDE|TABLE|IFRAME|HEADER|FOOTER)$/;
    const flat = el => [...el.children].flatMap(c => !BLOCKS.test(c.tagName) && !/twitter|iframe|sponsored/.test(String(c.className)) && c.querySelector('p') ? flat(c) : [c]);
    return flat(el); }
  function sections(children) {
    const out = []; let cur = []; let title = 'intro'; let n = 0; const seenT = {};
    const flush = () => { const b = union(cur); const k = keyOf(title) || 'section'; seenT[k] = (seenT[k] || 0) + 1;
      if (b) out.push({ name: `body/${k}${seenT[k] > 1 ? '~' + seenT[k] : ''}`, box: b, title, order: n, family: 'body-section', _els: cur }); n++; cur = []; };
    for (const e of children) {
      if (e.tagName === 'H2') {
        const carry = []; while (cur.length && cur[cur.length - 1].tagName === 'IMG' && getComputedStyle(cur[cur.length - 1]).float !== 'none') carry.unshift(cur.pop());
        if (cur.length) flush(); cur = carry; title = clean(e.innerText);
      }
      cur.push(e);
    }
    if (cur.length) flush();
    return out;
  }

  // ---- per-region style/geometry samples: the "tightest" element for each text, plus images
  const PROPS = ['font-family','font-size','font-weight','line-height','color','letter-spacing','text-transform','text-align',
    'padding-top','padding-right','padding-bottom','padding-left','margin-top','margin-right','margin-bottom','margin-left',
    'background-color','-webkit-font-smoothing','text-rendering','font-feature-settings','font-kerning','font-stretch','border-top-width','border-bottom-width','border-top-color','border-bottom-color','border-radius','text-decoration-line'];
  const sample = (els, box) => {
    const roots = els; const out = []; const occ = {};
    const push = (e, key) => { occ[key] = (occ[key] || 0) + 1; if (out.length > 500) return;
      const cs = getComputedStyle(e); const r = R(e); const st = {}; for (const p of PROPS) st[p] = cs.getPropertyValue(p);
      st['font-family'] = st['font-family'].split(',')[0].replace(/["']/g, '').trim();
      // effective background: the first painted ancestor (wrapper depth differs between the two DOMs)
      for (let a = e; a && a !== document.body; a = a.parentElement) { const bg = getComputedStyle(a).backgroundColor; if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { st['background-color'] = bg; break; } }
      const disabled = !!e.closest('[aria-disabled=true], :disabled, .cursor-not-allowed');
      // text properties only mean something where the element paints its own text
      const inlineOnly = [...e.children].every(c => getComputedStyle(c).display === 'inline' || c.tagName === 'BR');
      out.push({ key: `${key}#${occ[key]}`, tag: e.tagName.toLowerCase(), cls: (typeof e.className === 'string' ? e.className : '').slice(0, 300),
        rect: [r[0] - box[0], r[1] - box[1], r[2], r[3]], style: st, disabled, inlineOnly, text: clean(e.innerText).slice(0, 60) }); };
    for (const root of roots) {
      const all = [root, ...root.querySelectorAll('*')];
      for (const e of all) {
        if (!vis(e) || ['svg','path','g','use','script','style','br'].includes(e.tagName.toLowerCase())) continue;
        if (e.tagName === 'IMG') { const f = (e.currentSrc || e.src || '').split('?')[0].split('/').pop().replace(/[_-]\d+x\d+.*$/, ''); push(e, 'img:' + f); continue; }
        const t = clean(e.innerText); if (!t || t.length > 300) continue;
        // tightest non-inline box for this text (inline <span> runs defer to their block)
        if ([...e.children].some(c => clean(c.innerText) === t && getComputedStyle(c).display !== 'inline')) continue;
        if (getComputedStyle(e).display === 'inline' && e.parentElement && clean(e.parentElement.innerText) === t) continue;
        push(e, 'txt:' + t.replace(AGE_IN, '<age>').slice(0, 80));
      }
    }
    return out;
  };
  for (const r of regions) {
    const els = r._els || (r._el ? [r._el] : []);
    r.els = r.family === 'column' || r.family === 'article' || r.name === 'news-feed' ? [] : sample(els, r.box);
    r.imgs = els.flatMap(e => [...(e.tagName === 'IMG' ? [e] : []), ...e.querySelectorAll('img, picture, video')]).filter(vis).map(R).filter(b => b[2] * b[3] > 2500);
    delete r._el; delete r._els;
  }
  const bs = getComputedStyle(document.body);
  const pageStyle = { '-webkit-font-smoothing': bs.webkitFontSmoothing, 'body font-family': bs.fontFamily.split(',')[0].replace(/["']/g, ''), 'body background-color': bs.backgroundColor, 'body color': bs.color };
  return { regions, masks, pageStyle, docH: document.documentElement.scrollHeight, lock: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } };
}

// Ref-only normalisation for recorded deliberate deviations (story-page-gaps).
function normaliseRef({ template }) {
  const hidden = [];
  const BLOCKS = /^(P|H[1-6]|UL|OL|HR|BLOCKQUOTE|FIGURE|IMG|ASIDE|TABLE|IFRAME|HEADER|FOOTER)$/;
    const flat = el => [...el.children].flatMap(c => !BLOCKS.test(c.tagName) && !/twitter|iframe|sponsored/.test(String(c.className)) && c.querySelector('p') ? flat(c) : [c]);
  const hide = (el, why) => { el.style.setProperty('display', 'none', 'important'); hidden.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} (${why})`); };
  if (template === 'story') {
    const body = document.querySelector('#article-feed article.article .article-body');
    if (body) for (const e of flat(body)) {
      if (e.matches('.article-meta, .content-reactions')) continue;
      if (e.matches('.twitter-tweet, blockquote.twitter-tweet, .sponsored-links, aside, .module-iframe-wrapper, iframe, .ad-300, [class*=ad-slot], .inline-track, .alsosee, .ad-banner-wrapper')) { hide(e, 'dropped embed'); continue; }
      if (e.tagName === 'P' && !(e.innerText || '').trim() && !e.querySelector('img')) { hide(e, 'empty/embed placeholder'); continue; }
      if (e.querySelector('iframe, .twitter-tweet') && !(e.innerText || '').trim()) hide(e, 'dropped embed');
    }
    // the duplicated pinned story (the clone lists it once, pinned)
    const seen = new Set();
    for (const it of document.querySelectorAll('#news-feed .news-feed-item[data-id]')) {
      const id = it.getAttribute('data-id'); if (seen.has(id)) hide(it, 'duplicate pinned story'); seen.add(id);
      it.classList.remove('active');
    }
    document.querySelectorAll('#news-feed .story_progress').forEach(e => e.style.setProperty('display', 'none', 'important'));
  }
  return hidden;
}

// ------------------------------------------------------------------ browser side
async function openPage(ctx, url, side, template) {
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: BLOCK });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await p.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await p.waitForTimeout(side === 'ref' ? 3000 : 1500);
  await p.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}
    #global-header li.user, li.Nav__Primary__Menu__Item--User{visibility:hidden!important}
    .article-legal-footer{display:none!important}` });
  // lazy content: scroll the first screenfuls (story: to the end of the first article only)
  await p.evaluate(async ({ template }) => {
    const s = ms => new Promise(r => setTimeout(r, ms));
    const art = document.querySelector('#article-feed article.article, article[data-story-id]');
    const end = template === 'story' && art ? art.getBoundingClientRect().bottom + scrollY - 1200 : 5000;
    for (let y = 0; y < end; y += 800) { window.scrollTo(0, y); await s(220); }
    window.scrollTo(0, 0); await s(1200);
  }, { template });
  // the clone's fixed legal bar
  await p.evaluate(() => { for (const f of document.querySelectorAll('footer, div')) if (getComputedStyle(f).position === 'fixed' && f.getBoundingClientRect().bottom >= innerHeight - 2 && f.getBoundingClientRect().width >= 1000) f.style.setProperty('display', 'none', 'important'); });
  const hidden = side === 'ref' ? await p.evaluate(normaliseRef, { template }) : [];
  await p.waitForTimeout(600);
  return { p, hidden };
}

async function shoot(p, box) {
  // device-pixel precise (DPR 2): a .5 CSS origin must not shift the crop by one device px
  const q = v => Math.round(v * 2) / 2;
  const [x, y, w, h0] = box.map(q);
  const h = Math.min(h0, REGION_CAP);
  if (w <= 0 || h <= 0) return null;
  const buf = await p.screenshot({ clip: { x: Math.max(0, x), y: Math.max(0, y), width: w, height: h }, fullPage: true, animations: 'disabled' });
  return PNG.sync.read(buf);
}

// ------------------------------------------------------------------ pixel diff
function diffImages(a, b, maskRectsDev) {
  const W = Math.max(a.width, b.width), H = Math.max(a.height, b.height);
  const mask = new Uint8Array(W * H);
  for (const [x0, y0, w, h] of maskRectsDev) {
    const xs = Math.max(0, Math.floor(x0)), ys = Math.max(0, Math.floor(y0)), xe = Math.min(W, Math.ceil(x0 + w)), ye = Math.min(H, Math.ceil(y0 + h));
    for (let y = ys; y < ye; y++) mask.fill(1, y * W + xs, y * W + xe);
  }
  const out = new PNG({ width: W, height: H });
  let diff = 0, masked = 0, outside = 0; const rowDiff = new Uint32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, o = k * 4;
    const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
    const ia = (y * a.width + x) * 4, ib = (y * b.width + x) * 4;
    const g = inA ? (a.data[ia] * 0.3 + a.data[ia + 1] * 0.59 + a.data[ia + 2] * 0.11) : 255;
    if (mask[k]) { masked++; out.data[o] = 120; out.data[o + 1] = 160; out.data[o + 2] = 255; out.data[o + 3] = 255; continue; }
    let d;
    if (!inA || !inB) { d = true; outside++; }
    else d = Math.abs(a.data[ia] - b.data[ib]) > THRESH || Math.abs(a.data[ia + 1] - b.data[ib + 1]) > THRESH || Math.abs(a.data[ia + 2] - b.data[ib + 2]) > THRESH;
    if (d) { diff++; rowDiff[y]++; out.data[o] = 255; out.data[o + 1] = inA && inB ? 0 : 160; out.data[o + 2] = 0; }
    else { const v = 255 - (255 - g) * 0.25; out.data[o] = out.data[o + 1] = out.data[o + 2] = v; }
    out.data[o + 3] = 255;
  }
  const compared = W * H - masked;
  // 1-device-px shift tolerance: a differing pixel counts only if no neighbour in the other image matches
  let diffShift = 0;
  const near = (x, y) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const bx = x + dx, by = y + dy;
    if (bx < 0 || by < 0 || bx >= b.width || by >= b.height) continue; const ia = (y * a.width + x) * 4, ib = (by * b.width + bx) * 4;
    if (Math.abs(a.data[ia] - b.data[ib]) <= THRESH && Math.abs(a.data[ia + 1] - b.data[ib + 1]) <= THRESH && Math.abs(a.data[ia + 2] - b.data[ib + 2]) <= THRESH) return true; } return false; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (mask[k]) continue; const o = k * 4;
    if (out.data[o] === 255 && out.data[o + 2] === 0 && out.data[o + 1] !== out.data[o]) { if (x >= a.width || y >= a.height || !near(x, y)) diffShift++; } }
  // first differing row band, for the report
  let firstRow = -1; for (let y = 0; y < H; y++) if (rowDiff[y] > 2) { firstRow = y; break; }
  return { W, H, diff, masked, outside, compared, pct: compared ? diff / compared * 100 : 0, pctShift: compared ? diffShift / compared * 100 : 0, png: out, firstDiffRowCss: firstRow < 0 ? null : Math.round(firstRow / 2) };
}

// ------------------------------------------------------------------ style/geometry diff
const NUM = v => { const m = String(v).match(/^-?[\d.]+/); return m ? parseFloat(m[0]) : null; };
function styleDiffs(refEls, cloneEls) {
  const cm = new Map(cloneEls.map(e => [e.key, e]));
  const out = []; let matched = 0;
  for (const r of refEls) {
    const c = cm.get(r.key); if (!c) continue; matched++;
    const area = Math.max(1, r.rect[2] * r.rect[3]);
    const add = (prop, rv, cv, impact) => out.push({ key: r.key, text: r.text, refTag: r.tag, cloneTag: c.tag, cloneCls: c.cls, prop, ref: rv, clone: cv, impact: Math.round(impact) });
    const [rx, ry, rw, rh] = r.rect, [cx, cy, cw, ch] = c.rect;
    if (Math.abs(rw - cw) > 1) add('width', +rw.toFixed(1), +cw.toFixed(1), Math.abs(rw - cw) * Math.max(rh, ch));
    if (Math.abs(rh - ch) > 1) add('height', +rh.toFixed(1), +ch.toFixed(1), Math.abs(rh - ch) * Math.max(rw, cw));
    if (Math.abs(rx - cx) > 1) add('x (in region)', +rx.toFixed(1), +cx.toFixed(1), Math.min(Math.abs(rx - cx), 20) * rh * 0.5);
    if (Math.abs(ry - cy) > 1) add('y (in region)', +ry.toFixed(1), +cy.toFixed(1), 0);   // cascades; reported, not ranked
    const TEXT = /^(font-|line-height|color$|letter-spacing|text-|-webkit-font-smoothing)/;
    for (const p of Object.keys(r.style)) {
      const rv = r.style[p], cv = c.style[p];
      if (p === '-webkit-font-smoothing') continue;                         // page-level, reported once
      if (TEXT.test(p) && !(r.inlineOnly && c.inlineOnly)) continue;       // container: inherited, not painted
      if (/^(padding|margin)/.test(p) && r.tag !== c.tag) continue;        // different nesting level
      if (rv === cv) continue;
      if (c.disabled && (p === 'color' || p === 'text-decoration-line' || /border-.*-color/.test(p))) continue;   // deliberate disabled grey
      const rn = NUM(rv), cn = NUM(cv);
      if (rn !== null && cn !== null && /px|^\d/.test(rv) && Math.abs(rn - cn) <= 0.5 && !/color/.test(p)) continue;
      if (/border-(top|bottom)-color/.test(p) && NUM(r.style[p.replace('color', 'width')]) === 0 && NUM(c.style[p.replace('color', 'width')]) === 0) continue;
      if (p === 'line-height' && (rv === 'normal' || cv === 'normal')) { add(p, rv, cv, area * 0.2); continue; }
      let impact;
      if (p === 'font-size') impact = area * Math.min(1, Math.abs(rn - cn) / 4) * 1.2;
      else if (p === 'font-weight') impact = area * 0.6;
      else if (p === 'font-family') impact = area * 0.4;
      else if (p === 'color' || p === 'background-color') impact = (p === 'color' ? area * 0.5 : area * 0.8);
      else if (/padding|margin/.test(p)) impact = Math.abs((rn || 0) - (cn || 0)) * Math.max(rw, 40);
      else if (p === 'line-height') impact = Math.abs((rn || 0) - (cn || 0)) * rw;
      else impact = area * 0.15;
      add(p, rv, cv, impact);
    }
  }
  return { matched, refN: refEls.length, cloneN: cloneEls.length, diffs: out };
}

// likely responsible component: files under frontend/components whose source contains the
// clone element's most distinctive class tokens
const COMP_DIR = `${REPO}/frontend/components`;
const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(f) ? [p] : []; });
const COMP = walk(COMP_DIR).map(f => ({ f: relative(REPO, f), src: readFileSync(f, 'utf8') }));
const REGION_DEFAULT = {
  story: { 'global-nav': 'GlobalNav/GlobalNav.tsx', 'league-bar': 'LeagueNav/LeagueNav.tsx', 'news-feed': 'StoryFeed/StoryFeed.tsx', 'feed-item': 'StoryFeed/StoryFeed.tsx',
    'article-header': 'StoryArticle/StoryArticle.tsx', hero: 'StoryArticle/StoryVideo.tsx', byline: 'StoryArticle/StoryArticle.tsx', reactions: 'StoryArticle/StoryArticle.tsx', body: 'StoryArticle/StoryBody.tsx', article: 'StoryArticle/StoryArticle.tsx' },
  team: { 'global-nav': 'GlobalNav/GlobalNav.tsx', band: 'TeamPage/TeamHeader.tsx', tabs: 'common/SecondaryNav/SecondaryNav.tsx', left: 'TeamPage/TeamSchedule.tsx', main: 'TeamPage/TeamFeed.tsx', right: 'TeamPage/TeamRail.tsx', 'page-footer': 'PageFooter/PageFooter.tsx' },
  player: { 'global-nav': 'GlobalNav/GlobalNav.tsx', band: 'PlayerPage/PlayerHeader.tsx', tabs: 'common/SecondaryNav/SecondaryNav.tsx', left: 'PlayerPage/PlayerLeft.tsx', main: 'PlayerPage/PlayerStats.tsx', right: 'GroupStandings/GroupStandings.tsx', 'page-footer': 'PageFooter/PageFooter.tsx' },
};
function responsible(template, region, cls) {
  const toks = (cls || '').split(/\s+/).filter(t => /\[|^(benton|story-serif|espn-)/.test(t));
  const fallback = `frontend/components/${REGION_DEFAULT[template][region.split('/')[0]] || REGION_DEFAULT[template][region.split(/[/-]/)[0]] || '?'}`;
  if (!toks.length) return fallback;
  let best = null, bestN = 0;
  for (const { f, src } of COMP) { const n = toks.filter(t => src.includes(t)).length; if (n > bestN || (n === bestN && n > 0 && f === fallback)) { best = f; bestN = n; } }
  return bestN >= Math.min(2, toks.length) ? best : fallback;
}

// ------------------------------------------------------------------ run one page
function relMasks(masks, box) {
  const out = [];
  for (const m of masks) {
    const [x, y, w, h] = m.box;
    const x0 = Math.max(x, box[0]), y0 = Math.max(y, box[1]), x1 = Math.min(x + w, box[0] + box[2]), y1 = Math.min(y + h, box[1] + box[3]);
    if (x1 > x0 && y1 > y0) out.push({ box: [x0 - box[0], y0 - box[1], x1 - x0, y1 - y0], why: m.why });
  }
  return out;
}

async function runPage(ctx, template, slug, path) {
  const dir = `${OUT}/${template}/${slug}`;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const sides = {};
  for (const side of ['ref', 'clone']) {
    const url = (side === 'ref' ? REF : CLONE) + path;
    const { p, hidden } = await openPage(ctx, url, side, template);
    const main = await p.evaluate(collect, { side, template, phase: 'main' });
    if (main.lock.w !== 1440 || main.lock.h !== 900 || main.lock.dpr !== 2) throw new Error(`${side} lock ${JSON.stringify(main.lock)}`);
    const shots = {};
    for (const r of main.regions) shots[r.name] = await shoot(p, r.box);
    const fullBox = [0, 0, 1440, Math.min(main.docH, FULL_CAP)];
    shots.__full = await shoot(p, fullBox);
    let feed = null;
    if (template === 'story') {
      // expand the independently scrolling feed so every item is on the canvas
      await p.addStyleTag({ content: `#news-feed, #news-feed-content, #news-feed .container-wrapper, [data-story-page] nav{position:relative!important;top:0!important;height:auto!important;max-height:none!important;overflow:visible!important}` });
      await p.waitForTimeout(500);
      feed = await p.evaluate(collect, { side, template, phase: 'feed' });
      for (const r of feed.regions) shots[r.name] = await shoot(p, r.box);
    }
    const meta = await p.evaluate(() => ({ url: location.href, title: document.title }));
    sides[side] = { main, feed, shots, hidden, meta, fullBox };
    await p.close();
  }

  const rows = [];
  const doRegion = (name, rR, cR, rMasks, cMasks, shotR, shotC) => {
    const row = { region: name, title: rR?.title || cR?.title || null, family: rR?.family || cR?.family || name.split('/')[0] };
    if (!rR || !cR) { row.status = !rR ? 'CLONE-ONLY' : 'MISSING-ON-CLONE'; row.refBox = rR?.box; row.cloneBox = cR?.box; rows.push(row); return; }
    row.refBox = rR.box.map(v => +v.toFixed(1)); row.cloneBox = cR.box.map(v => +v.toFixed(1));
    if (rR.masked || cR.masked) { row.status = 'MASKED'; row.reason = rR.maskReason || cR.maskReason; rows.push(row); return; }
    if (!shotR || !shotC) { row.status = 'NO-SHOT'; rows.push(row); return; }
    const mr = relMasks(rMasks, rR.box), mc = relMasks(cMasks, cR.box);
    const all = [...mr, ...mc];
    const d = diffImages(shotR, shotC, all.map(m => m.box.map(v => v * 2)));
    const imgM = [...relMasks((rR.imgs || []).map(b => ({ box: b })), rR.box), ...relMasks((cR.imgs || []).map(b => ({ box: b })), cR.box)];
    const dNoImg = imgM.length ? diffImages(shotR, shotC, [...all, ...imgM].map(m => m.box.map(v => v * 2))) : d;
    const rd = `${dir}/${name.replace(/[^A-Za-z0-9_.-]+/g, '_')}`; mkdirSync(rd, { recursive: true });
    writeFileSync(`${rd}/ref.png`, PNG.sync.write(shotR)); writeFileSync(`${rd}/clone.png`, PNG.sync.write(shotC)); writeFileSync(`${rd}/diff.png`, PNG.sync.write(d.png));
    const areaR = shotR.width * shotR.height, areaC = shotC.width * shotC.height;
    const sizeDelta = Math.abs(areaR - areaC) / Math.max(areaR, areaC);
    const whys = [...new Set(all.map(m => m.why))];
    Object.assign(row, { refSize: [Math.round(rR.box[2]), Math.round(rR.box[3])], cloneSize: [Math.round(cR.box[2]), Math.round(cR.box[3])],
      pixelsCompared: d.compared, pixelsMasked: d.masked, pixelsDiffering: d.diff, pixelsOutsideOverlap: d.outside,
      pct: +d.pct.toFixed(2), pctExclImages: +dNoImg.pct.toFixed(2), pctShiftTolerant: +dNoImg.pctShift.toFixed(2), maskedPct: +(d.masked / (d.W * d.H) * 100).toFixed(1), maskReasons: whys, firstDiffYcss: d.firstDiffRowCss,
      sizeDeltaPct: +(sizeDelta * 100).toFixed(1),
      status: d.diff === 0 && sizeDelta === 0 ? 'EXACT' : d.pct < MATCH_PCT && sizeDelta <= SIZE_TOL ? 'MATCH' : 'DIFF' });
    const sd = styleDiffs(rR.els || [], cR.els || []);
    row.elements = { ref: sd.refN, clone: sd.cloneN, matched: sd.matched };
    row.styleDiffs = sd.diffs.sort((a, b) => b.impact - a.impact).map(x => ({ ...x, file: responsible(template, name, x.cloneCls) }));
    rows.push(row);
  };
  const R = sides.ref, C = sides.clone;
  const pairUp = (rs, cs) => {
    const cmap = new Map(); cs.forEach(c => { if (!cmap.has(c.name)) cmap.set(c.name, c); });
    const used = new Set(); const pairs = [];
    for (const r of rs) { let c = cmap.get(r.name); if (c && used.has(c.name)) c = null; if (c) used.add(c.name); pairs.push([r, c]); }
    // fallback: same family + order among the unmatched (e.g. body sections whose heading text differs)
    for (const pr of pairs) if (!pr[1]) {
      const c = cs.find(x => !used.has(x.name) && x.family === pr[0].family && x.family && x.order === pr[0].order && /body-section/.test(x.family));
      if (c) { used.add(c.name); pr[1] = c; }
    }
    for (const c of cs) if (!used.has(c.name)) pairs.push([null, c]);
    return pairs;
  };
  for (const [r, c] of pairUp(R.main.regions, C.main.regions)) {
    if (!c && /\/feed\//.test(r.name)) { rows.push({ region: r.name, family: r.family, title: r.title, status: 'REF-ONLY (live feed content)' }); continue; }
    doRegion((r || c).name, r, c, R.main.masks, C.main.masks, r && R.shots[r.name], c && C.shots[c.name]); }
  if (R.feed) for (const [r, c] of pairUp(R.feed.regions, C.feed.regions)) {
    if (!r || !c) { rows.push({ region: (r || c).name, family: 'feed-item', title: (r || c).title, status: !r ? 'CLONE-ONLY' : 'REF-ONLY (live feed content)' }); continue; }
    doRegion(r.name, r, c, R.feed.masks, C.feed.masks, R.shots[r.name], C.shots[c.name]);
  }
  // full page (capped): masks = page masks + every masked region box
  const pm = side => [...sides[side].main.masks, ...sides[side].main.regions.filter(x => x.masked).map(x => ({ box: x.box, why: x.maskReason }))];
  doRegion('__full-page', { box: R.fullBox, title: `full page (top ${FULL_CAP}px)`, family: 'full', els: [] }, { box: C.fullBox, family: 'full', els: [] }, pm('ref'), pm('clone'), R.shots.__full, C.shots.__full);

  const pageStyle = Object.keys(R.main.pageStyle).map(k => ({ prop: k, ref: R.main.pageStyle[k], clone: C.main.pageStyle[k] })).filter(x => x.ref !== x.clone);
  const report = { template, slug, path, at: new Date().toISOString(), ref: R.meta, clone: C.meta, pageStyle,
    refHiddenBeforeCapture: R.hidden, rule: `channel delta > ${THRESH}; MATCH = <${MATCH_PCT}% and area within ${SIZE_TOL * 100}%`, regions: rows };
  writeFileSync(`${dir}/report.json`, JSON.stringify(report, null, 1));
  const cmp = rows.filter(r => ['EXACT', 'MATCH', 'DIFF'].includes(r.status) && r.region !== '__full-page' && r.family !== 'column');
  console.log(`${template}/${slug}: ${cmp.filter(r => r.status !== 'DIFF').length}/${cmp.length} regions match; masked ${rows.filter(r => r.status === 'MASKED').length}; unmatched ${rows.filter(r => /ONLY|MISSING/.test(r.status)).length}`);
  return report;
}

// ------------------------------------------------------------------ summary
function summary() {
  const reports = [];
  for (const t of ['story', 'team', 'player']) {
    if (!existsSync(`${OUT}/${t}`)) continue;
    for (const s of readdirSync(`${OUT}/${t}`)) { const f = `${OUT}/${t}/${s}/report.json`; if (existsSync(f)) reports.push(JSON.parse(readFileSync(f, 'utf8'))); }
  }
  const L = [];
  L.push('# Template pixel report: story / team / player vs espn.com', '');
  L.push(`Generated ${new Date().toISOString()} by \`never_to_be_pushed/discovery/tools/template-diff.mjs\`.`, '');
  L.push('**Re-run** (from the repo root, with the clone on :3000 and the pw-profile browser on CDP :9222):', '',
    '```bash', 'node never_to_be_pushed/discovery/tools/template-diff.mjs                 # all 12 pages + this summary',
    'node never_to_be_pushed/discovery/tools/template-diff.mjs --only=team     # one template',
    'node never_to_be_pushed/discovery/tools/template-diff.mjs --slug=nfl-buf  # one page', 'node never_to_be_pushed/discovery/tools/template-diff.mjs --summary-only    # rebuild SUMMARY.md from report.json files', '```', '');
  L.push('Method: both sides in the same Chrome at 1440x900 @2 light, third parties blocked. Each region is located by DOM rect on each side and clipped from the full-page canvas; ',
    `a pixel differs when any channel differs by more than ${THRESH} (scripts/pixel-diff.mjs). Crops of different size are compared over the larger box and the non-overlap counts as differing. `,
    `**MATCH** = under ${MATCH_PCT}% differing and crop area within ${SIZE_TOL * 100}%; **EXACT** = 0 px. "% diff" is of the unmasked pixels; "masked" is the share of the crop masked.`, '',
    'Masked: relative ages and timestamps (incl. the byline date format deviation), the live score strip, ads/sponsored, the Find Tickets partner card, video media, Follow-button state, the account control, and the clone\'s disabled treatment (`unserved-links-disabled`, `story-page-gaps`, `team-player-*`: glyph boxes of `[aria-disabled]`/`:disabled` elements, whole box for small controls). ',
    'Removed from the reference before capture (story-page-gaps): tweets, iframes, Editor\'s Picks / promo asides, in-body ad and empty embed paragraphs, and the duplicated pinned feed item. The reference is live, so feed items that are not in the seed are listed as REF-ONLY and not compared.', '');

  const allDiffs = [];
  const ps = new Map(); for (const r of reports) for (const x of r.pageStyle || []) { const k = `${x.prop}|${x.ref}|${x.clone}`; const g = ps.get(k) || { ...x, pages: [] }; g.pages.push(`${r.template}/${r.slug}`); ps.set(k, g); }
  if (ps.size) { L.push('## Page-level differences (affect every glyph on the page)', '', '| property | reference | clone | pages |', '|---|---|---|---|');
    for (const g of ps.values()) L.push(`| ${g.prop} | ${g.ref} | ${g.clone} | ${g.pages.length}/${reports.length} |`);
    L.push('', 'Font smoothing alone makes antialiased glyph edges differ on every text pixel, which is why text-heavy regions sit at 5-10% even when every box and font property matches; the "±1px" column does not absorb it. Fix it first and re-run before reading the smaller percentages.', ''); }
  for (const t of ['story', 'team', 'player']) {
    const rs = reports.filter(r => r.template === t); if (!rs.length) continue;
    L.push(`## ${t.toUpperCase()}`, '');
    const cmp = rs.flatMap(r => r.regions.filter(x => ['EXACT', 'MATCH', 'DIFF'].includes(x.status) && x.region !== '__full-page' && x.family !== 'column'));
    const full = rs.map(r => r.regions.find(x => x.region === '__full-page')).filter(Boolean);
    L.push(`**Regions matching: ${cmp.filter(x => x.status !== 'DIFF').length} / ${cmp.length}** (exact ${cmp.filter(x => x.status === 'EXACT').length}) across ${rs.length} pages. Full page (top ${FULL_CAP}px) differing: ${full.map(f => f.pct + '%').join(', ')}.`, '');
    for (const r of rs) {
      L.push(`### ${t}/${r.slug} — \`${r.path}\``, '');
      if (r.refHiddenBeforeCapture?.length) L.push(`Ref elements removed before capture: ${r.refHiddenBeforeCapture.length} (${[...new Set(r.refHiddenBeforeCapture.map(h => h.replace(/^.*\(/, '(')))].join(', ')}).`, '');
      L.push('| region | status | % diff | % excl. images | % excl. images, ±1px | masked | ref WxH | clone WxH | first diff y | notes |', '|---|---|---:|---:|---:|---:|---|---|---:|---|');
      const order = { DIFF: 0, 'MISSING-ON-CLONE': 1, MATCH: 2, EXACT: 3, MASKED: 4, 'CLONE-ONLY': 5, 'REF-ONLY (live feed content)': 6 };
      const regs = [...r.regions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.pct || 0) - (a.pct || 0));
      const feedOnly = regs.filter(x => /ONLY/.test(x.status) && /feed/.test(x.family || ''));
      for (const x of regs) {
        if (feedOnly.includes(x)) continue;
        const note = x.status === 'MASKED' ? x.reason : x.maskReasons?.length ? 'masks: ' + x.maskReasons.join(', ') : x.title && x.title !== x.region ? String(x.title).slice(0, 40).replace(/\|/g, '/') : '';
        L.push(`| ${x.region} | ${x.status} | ${x.pct ?? ''} | ${x.pctExclImages ?? ''} | ${x.pctShiftTolerant ?? ''} | ${x.maskedPct != null ? x.maskedPct + '%' : ''} | ${x.refSize ? x.refSize.join('x') : x.refBox ? x.refBox.slice(2).map(Math.round).join('x') : ''} | ${x.cloneSize ? x.cloneSize.join('x') : x.cloneBox ? x.cloneBox.slice(2).map(Math.round).join('x') : ''} | ${x.firstDiffYcss ?? ''} | ${note} |`);
      }
      if (feedOnly.length) L.push('', `Feed items present on one side only (live feed vs seed, not compared): ref-only ${feedOnly.filter(x => /REF/.test(x.status)).length}, clone-only ${feedOnly.filter(x => /CLONE/.test(x.status)).length}.`);
      L.push('');
      for (const x of r.regions) for (const d of x.styleDiffs || []) allDiffs.push({ template: t, slug: r.slug, region: x.region, ...d });
    }
    L.push('');
  }

  // group identical differences across pages and elements
  const gen = region => region.replace(/\/feed\/.*/, '/feed-card').replace(/^body\/\d+-.*/, 'body-section').replace(/^feed-item\/.*/, 'feed-item');
  const groups = new Map();
  for (const d of allDiffs) {
    if (d.prop === 'y (in region)') continue;
    const sig = `${d.cloneTag}.${(d.cloneCls || '').split(/\s+/).filter(Boolean).slice(0, 6).join('.')}`;
    const k = [d.template, gen(d.region), d.prop, d.ref, d.clone, sig].join('|');
    const g = groups.get(k) || { template: d.template, region: gen(d.region), prop: d.prop, ref: d.ref, clone: d.clone, file: d.file, sig, example: d.text || d.key, refTag: d.refTag, count: 0, pages: new Set(), impact: 0 };
    g.count++; g.pages.add(d.slug); g.impact += d.impact; groups.set(k, g);
  }
  const ranked = [...groups.values()].filter(g => g.impact > 0).sort((a, b) => b.impact - a.impact);
  L.push('## Ranked concrete differences (all templates)', '',
    'Grouped by template, region, element, property and values; impact = affected px area summed over occurrences (size deltas x extent, typography x text box area, spacing x width). ',
    'Vertical offsets are omitted (they cascade from the size deltas above them) but are in each report.json. "file" is the component whose source contains the clone element\'s arbitrary-value classes (fallback: the region\'s component).', '',
    '| # | template | region | element (example text) | property | reference | clone | n | pages | impact | file |', '|---:|---|---|---|---|---|---|---:|---:|---:|---|');
  ranked.slice(0, 150).forEach((g, i) => L.push(`| ${i + 1} | ${g.template} | ${g.region} | ${g.refTag}→${g.sig.split('.')[0]} "${String(g.example).replace(/^(txt|img):/, '').replace(/#\d+$/, '').slice(0, 38).replace(/\|/g, '/')}" | ${g.prop} | ${g.ref} | ${g.clone} | ${g.count} | ${g.pages.size} | ${g.impact} | ${g.file} |`));
  writeFileSync(`${OUT}/SUMMARY.md`, L.join('\n') + '\n');
  writeFileSync(`${OUT}/ranked.json`, JSON.stringify(ranked.slice(0, 400).map(g => ({ ...g, pages: [...g.pages] })), null, 1));
  console.log(`SUMMARY.md written (${ranked.length} grouped differences)`);
}

// ------------------------------------------------------------------ main
mkdirSync(OUT, { recursive: true });
if (!SUMMARY_ONLY) {
  try { const r = await fetch(CLONE + '/'); if (!r.ok) throw new Error(r.status); } catch (e) { console.error(`no clone at ${CLONE}`); process.exit(2); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  for (const [t, s, path] of PAGES) {
    if (ONLY && t !== ONLY) continue; if (SLUG && s !== SLUG) continue;
    // a live page (or the clone under HMR) can navigate mid-evaluate: retry twice
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await runPage(ctx, t, s, path); break; }
      catch (e) { console.error(`${t}/${s} ${attempt < 3 ? 'retrying' : 'FAILED'}: ${String(e.message || e).split('\n')[0]}`); }
    }
  }
  await browser.close().catch(() => {});
}
summary();
process.exit(0);
