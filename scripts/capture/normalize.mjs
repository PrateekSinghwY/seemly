import { chromium } from 'playwright';
import { A2_SELECTOR, A2_HEADING_SOURCE, A2_HEADING_SCOPE, A2_HEADING_NEVER, A2_KEEP } from '../lib/a2-selector.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { latestStamp } from '../lib/snapshot.mjs';
const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo

const ROOT  = REPO + '/never_to_be_pushed/discovery/scrape';
const STAMP = latestStamp(ROOT);
const BASE  = `${ROOT}/raw/${STAMP}`;
const OUT   = `${ROOT}/normalized`;
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ['home','/',                   null],
  ['nfl','/nfl/',                'nfl'],
  ['ncaaf','/college-football/',  'college-football'],
  ['nba','/nba/',                'nba'],
  ['wnba','/wnba/',              'wnba'],
];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const T = { league:[], team:[], article:[], video:[], nav_item:[], page:[], page_module:[], module_link:[], ui_copy:[], asset:[], ad_slot:[] };
const seen = k => { const s = new Set(); return v => (s.has(v) ? false : (s.add(v), true)); };
const navSeen = seen(), teamSeen = seen(), leagueSeen = seen(), copySeen = seen();
const FEED_CAPS = JSON.parse(readFileSync(`${ROOT}/feed-caps.json`, 'utf8'));

for (const [key, path, league] of PAGES) {
  await page.goto(`file://${BASE}/${key}/document.scrolled.html`, { waitUntil: 'domcontentloaded' });

  const d = await page.evaluate(({ key, league, A2_SELECTOR, A2_HEADING_SOURCE, HEAD_SCOPE, HEAD_NEVER, KEEP }) => {
    const clean = s => (s||'').replace(/\s+/g,' ').trim();
    // Responsive links render a long and a short label in one anchor, so innerText reads
    // "X X" or, for team links, "Buffalo Bills Bills" (long name + short name). Keep the long one.
    const dedupe = s => { const h=clean(s); const n=h.length>>1;
      if (h.length%2===1 && h[n]===' ' && h.slice(0,n)===h.slice(n+1)) return h.slice(0,n);
      const w=h.split(' ');
      for (let k=Math.floor(w.length/2); k>=1; k--) {
        const head=w.slice(0,-k), tail=w.slice(-k);
        if (head.length>k && head.slice(-k).join(' ')===tail.join(' ')) return head.join(' ');
      }
      return h; };
    const exSet = new Set(document.querySelectorAll(A2_SELECTOR));
    // documented keeps: named like a personal module, but public chrome
    document.querySelectorAll(KEEP).forEach(e => exSet.delete(e));
    const SIGNAL_TEXT = new RegExp(A2_HEADING_SOURCE, 'i');
    document.querySelectorAll(HEAD_SCOPE).forEach(m => {
      if (m.closest(HEAD_NEVER)) return;   // a feed item's headline is data, not a module name
      const h = m.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      if (h && SIGNAL_TEXT.test(clean(h.innerText))) exSet.add(m);
    });
    const isExcluded = el => { for (let e=el; e && e!==document.body; e=e.parentElement) if (exSet.has(e)) return true; return false; };
    const pathOf = href => { if(!href) return null; try { const u=new URL(href,'https://www.espn.com'); 
      return /(^|\.)espn\.com$/.test(u.hostname) ? u.pathname : u.href.split('?')[0]; } catch { return href.split('?')[0]; } };

    // ---- nav_item (hydrated DOM, ASSUMPTIONS A8) ----
    const nav = [];
    const lis = [...document.querySelectorAll('#global-nav li')].filter(li => !li.closest('li li'));
    lis.forEach((li, pillarIdx) => {
      // A nav PILLAR is public chrome even when its name carries a personalisation
      // signal: the Fantasy pillar is ESPN's public fantasy navigation, and excluding
      // the whole pillar dropped it from the seed entirely. Only its account-bound
      // CHILDREN are excluded, by the personal-query test below.
      const a = li.querySelector(':scope > a'); if (!a) return;
      // The edition picker's trigger has no text (it renders a flag). Record that as
      // null rather than inventing a placeholder label that would render on screen.
      const pillarLabel = dedupe(a.innerText) || null;
      nav.push({ pillar: pillarIdx, parent: null, group: null, order: pillarIdx, depth: 0,
                 label: pillarLabel, href: pathOf(a.getAttribute('href')),
                 is_current: pathOf(a.getAttribute('href')) === location.pathname });
      // children, preserving the group heading (e.g. "AFC East") when present
      let group = null; let order = 0;
      [...li.querySelectorAll('ul')].forEach(ul => {
        // ESPN marks a division/section heading as its own <li class="... label group">
        // sitting among the link items, not as a preceding element.
        [...ul.children].forEach(child => {
          if (isExcluded(child)) return;        // an excluded CHILD, not the pillar
          const cls = typeof child.className === 'string' ? child.className : '';
          if (/\blabel\b/.test(cls) && /\bgroup\b/.test(cls)) {
            group = clean(child.innerText).split(' ')[0] === clean(child.innerText)
              ? clean(child.innerText).slice(0, 30)
              : dedupe(child.innerText).slice(0, 30);
            return;
          }
          [...child.querySelectorAll('a'), ...(child.tagName === 'A' ? [child] : [])].forEach(k => {
            if (isExcluded(k)) return;
            const href = k.getAttribute('href') || '';
            if (/[?&](leagueId|teamId|seasonId|entryId)=/i.test(href)) return;   // A2
            nav.push({ pillar: pillarIdx, parent: pillarLabel, group, order: order++, depth: 1,
                       label: dedupe(k.innerText), href: pathOf(href), is_current: false });
          });
        });
      });
    });

    // ---- modules in document order, per column ----
    const mods = [];
    // col-two is the feed container itself: emit ONE module row for it, with its item
    // count, instead of one row per feed item.
    const feedCol = document.querySelector('.col-two');
    if (feedCol) {
      const r = feedCol.getBoundingClientRect();
      const cls = typeof feedCol.className === 'string' ? feedCol.className.trim() : '';
      mods.push({ column: 'col-two', order: 0,
                  dom_signature: feedCol.tagName.toLowerCase() + (feedCol.id ? '#' + feedCol.id : '') + '.' + cls.split(/\s+/).slice(0,2).join('.'),
                  title: null, is_feed: true,
                  item_count: feedCol.querySelectorAll('.contentItem').length,
                  link_count: feedCol.querySelectorAll('a').length,
                  img_count: feedCol.querySelectorAll('img').length });
    }
    ['.col-one','.col-three'].forEach(colSel => {
      const col = document.querySelector(colSel); if (!col) return;
      [...col.children].forEach((el, i) => {
        if (isExcluded(el)) return;
        const r = el.getBoundingClientRect();
        const h = el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
        const cls = typeof el.className==='string' ? el.className.trim() : '';
        if (r.height < 20) return;
        mods.push({ column: colSel.replace('.',''), order: i, dom_signature: (el.tagName.toLowerCase()+'.'+cls.split(/\s+/).slice(0,2).join('.')),
                    title: clean(h && h.innerText).slice(0,60) || null,
                    link_count: el.querySelectorAll('a').length, img_count: el.querySelectorAll('img').length });
      });
    });

    // ---- articles / videos from contentItem + headlineStack ----
    const articles = [], videos = [];
    document.querySelectorAll('.contentItem').forEach(ci => {
      if (isExcluded(ci)) return;
      const a = ci.querySelector('a[href]');
      const titleEl = ci.querySelector('[class*=contentItem__title]');
      const title = clean(titleEl && titleEl.innerText) || clean(ci.querySelector('h1,h2,h3')?.innerText);
      if (!title) return;
      const meta = clean(ci.querySelector('[class*=contentMeta]')?.innerText);
      const img = ci.querySelector('img');
      const durEl = [...ci.querySelectorAll('*')].find(e => /^\d{1,2}:\d{2}$/.test(clean(e.innerText)));
      const dur = durEl ? clean(durEl.innerText) : null;
      const ageEl = [...ci.querySelectorAll('*')].find(e => /^\d+[smhd]$/.test(clean(e.innerText)));
      const rec = { title, href: pathOf(a && a.getAttribute('href')), meta_verbatim: meta || null,
                    age_verbatim: ageEl ? clean(ageEl.innerText) : null,
                    image_url: img ? (img.currentSrc || img.src || null) : null, league };
      if (dur) videos.push({ ...rec, duration_verbatim: dur }); else articles.push(rec);
    });
    document.querySelectorAll('.headlineStack__list li a, .headlineStack__list a').forEach(a => {
      if (isExcluded(a)) return;
      const title = clean(a.innerText); if (!title) return;
      articles.push({ title, href: pathOf(a.getAttribute('href')), meta_verbatim: null,
                      age_verbatim: null, image_url: null, league, from: 'headlineStack' });
    });

    // ---- ui_copy: module titles + footer/legal + nav pillar labels ----
    const copy = [];
    document.querySelectorAll('.col-one > *, .col-three > *').forEach(el => {
      if (isExcluded(el)) return;
      const h = el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      const t = clean(h && h.innerText);
      if (t) copy.push({ scope: 'module_title', key: t.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,40), text: t });
    });
    document.querySelectorAll('footer a, .col-three a').forEach(a => {
      if (isExcluded(a)) return;
      const t = clean(a.innerText);
      if (t && t.length < 50 && /privacy|terms|contact|nielsen|ads|choices|children|state/i.test(t))
        copy.push({ scope: 'footer_legal', key: t.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,40), text: t, href: pathOf(a.getAttribute('href')) });
    });

    // ---- ad slots ----
    const ads = [...document.querySelectorAll('[id^=ad-slot], [class*=ad-slot]')].map((e,i) => {
      const r = e.getBoundingClientRect();
      return { slot_prefix: (e.id || '').replace(/-\d+$/, '') || (typeof e.className==='string'? e.className.split(/\s+/)[0] : 'ad-slot'),
               order: i, width: Math.round(r.width), height: Math.round(r.height), collapses: r.height === 0 };
    });

    // ---- leagues + teams from nav ----
    const leagues = [], teams = [];
    nav.forEach(n => {
      if (n.depth === 0 && n.href && /^\/[a-z-]+\/$/.test(n.href)) leagues.push({ slug: n.href.replace(/\//g,''), label: n.label, path: n.href });
      const m = n.href && n.href.match(/^\/([a-z-]+)\/team\/_\/(?:name|id)\/([^/]+)\/(.+)$/);
      if (m) teams.push({ league_slug: m[1], abbrev: m[2], slug: m[3], display_name: n.label, href: n.href, group: n.group });
    });

    // assets, A2-filtered. Previously taken from images.jsonl, which the capture
    // collected unfiltered, so fantasy-signup rail images reached the seed.
    const assets = [];
    document.querySelectorAll('img').forEach(i => {
      if (isExcluded(i)) return;
      const u = i.currentSrc || i.src || '';
      if (!u) return;
      const r = i.getBoundingClientRect();
      assets.push({ kind: 'img', url: u, alt: i.alt || '',
                    natural: [i.naturalWidth, i.naturalHeight],
                    rendered: [Math.round(r.width), Math.round(r.height)] });
    });
    document.querySelectorAll('svg use').forEach(u => {
      if (isExcluded(u)) return;
      const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      if (href) assets.push({ kind: 'use', url: href, alt: '', natural: null, rendered: null });
    });

    // module_link: what each rail actually contains. page_module records composition;
    // without this the modules render as empty boxes.
    const moduleLinks = [];
    ['.col-one', '.col-three'].forEach(colSel => {
      const col = document.querySelector(colSel); if (!col) return;
      [...col.children].forEach((el, order) => {
        if (isExcluded(el)) return;
        const r = el.getBoundingClientRect(); if (r.height < 20) return;
        const cls = typeof el.className === 'string' ? el.className.trim() : '';
        const sig = el.tagName.toLowerCase() + '.' + cls.split(/\s+/).slice(0,2).join('.');
        const h = el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
        const title = clean(h && h.innerText).slice(0,60) || null;
        [...el.querySelectorAll('a')].forEach((a, i) => {
          if (isExcluded(a)) return;
          const label = dedupe(a.innerText);
          if (!label) return;
          const img = a.querySelector('img');
          moduleLinks.push({ column: colSel.replace('.',''), module_order: order,
                             dom_signature: sig, module_title: title, order: i,
                             label, href: pathOf(a.getAttribute('href')),
                             icon_url: img ? (img.currentSrc || img.src || null) : null });
        });
      });
    });

    return { nav, mods, articles, videos, copy, ads, leagues, teams, assets, moduleLinks,
             grid: { one: document.querySelector('.col-one')?.getBoundingClientRect().width,
                     two: document.querySelector('.col-two')?.getBoundingClientRect().width,
                     three: document.querySelector('.col-three')?.getBoundingClientRect().width,
                     header: document.querySelector('#global-nav')?.getBoundingClientRect().height } };
  }, { key, league, A2_SELECTOR, A2_HEADING_SOURCE, HEAD_SCOPE: A2_HEADING_SCOPE, HEAD_NEVER: A2_HEADING_NEVER, KEEP: A2_KEEP });

  const cap = FEED_CAPS[key] || {};
  T.page.push({ key, path, league, title: null, grid: d.grid, module_count: d.mods.length,
                feed_captured_depth: cap.captured_depth ?? null,
                feed_page_size: cap.limit ?? null,
                feed_results_available: cap.results_count ?? null,
                feed_archetype: key === 'home' ? 'cross_sport_feed' : 'league_feed' });
  d.mods.forEach(m => {
    const isFeed = m.is_feed === true;
    T.page_module.push({ page_key: key, league_scope: league, ...m,
      params: isFeed ? JSON.stringify({
        feed_archetype: key === 'home' ? 'cross_sport_feed' : 'league_feed',
        page_size: cap.limit ?? null,
        captured_depth: cap.captured_depth ?? null,
        results_available: cap.results_count ?? null }) : null });
  });
  d.nav.forEach(n => { const id = `${key}|${n.pillar}|${n.depth}|${n.order}|${n.href}`;
    if (navSeen(`${n.depth}|${n.parent}|${n.label}|${n.href}|${n.group}`)) T.nav_item.push(n); });
  const artSeenPage = seen(), vidSeenPage = seen();
  d.articles.forEach((a, i) => { if (a.title && artSeenPage(a.title))
    T.article.push({ page_key: key, feed_order: i, ...a }); });
  d.videos.forEach((v, i) => { if (v.title && vidSeenPage(v.title))
    T.video.push({ page_key: key, feed_order: i, ...v }); });
  d.copy.forEach(c => { if (copySeen(c.scope + '|' + c.key)) T.ui_copy.push(c); });
  d.ads.forEach(a => T.ad_slot.push({ page_key: key, ...a }));
  d.leagues.forEach(l => { if (leagueSeen(l.slug)) T.league.push(l); });
  d.teams.forEach(t => { if (teamSeen(t.league_slug + '|' + t.abbrev)) T.team.push(t); });

  d.moduleLinks.forEach(m => T.module_link.push({ page_key: key, ...m }));

  // assets: A2-filtered at extraction (see LESSONS #10)
  d.assets.forEach(i => T.asset.push({ page_key: key, kind: i.kind,
    url_path: (i.url || '').split('?')[0],
    query: (i.url || '').includes('?') ? (i.url.split('?')[1] || '').slice(0, 120) : null,
    alt: i.alt || null, natural: i.natural || null, rendered: i.rendered || null }));

  console.log(`${key.padEnd(6)} nav ${String(d.nav.length).padStart(4)}  mods ${String(d.mods.length).padStart(3)}  art ${String(d.articles.length).padStart(3)}  vid ${String(d.videos.length).padStart(3)}  ads ${d.ads.length}  grid ${d.grid.one}/${d.grid.two}/${d.grid.three} hdr ${d.grid.header}`);
}

for (const [name, rows] of Object.entries(T))
  writeFileSync(`${OUT}/${name}.jsonl`, rows.map(r => JSON.stringify({ ...r, _provenance: `raw/${STAMP}` })).join('\n') + '\n');

console.log('\nnormalized rows:');
for (const [n, r] of Object.entries(T)) console.log(`  ${n.padEnd(14)} ${r.length}`);
await b.close();
