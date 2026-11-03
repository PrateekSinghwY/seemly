// SCRAPE Part 1-3: snapshot the five pages from the logged-out US persistent profile.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { A2_SELECTOR, A2_KEEP } from '../lib/a2-selector.mjs';
import { BLOCKED_URLS } from '../lib/block-list.mjs';
import { applyLock } from '../lib/lock.mjs';
const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo

const ROOT = REPO + '/never_to_be_pushed/discovery/scrape';
const PAGES = [
  ['home',  'https://www.espn.com/'],
  ['nfl',   'https://www.espn.com/nfl/'],
  ['ncaaf', 'https://www.espn.com/college-football/'],
  ['nba',   'https://www.espn.com/nba/'],
  ['wnba',  'https://www.espn.com/wnba/'],
];
// Responses never RECORDED: every blocked host, plus the identity bootstrap hosts, which
// load (the score strip needs them) but whose bodies carry session tokens.
const glob = g => new RegExp(g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i');
const RECORD_SKIP = [...BLOCKED_URLS, '*bamgrid*', '*registerdisney*'].map(glob);

// ---- Part 3 scrub -------------------------------------------------------
// Keys are matched by WORD, never by substring: a bare `/ip|lat|lon|user/` deleted
// `description`, `tipoff`, `related`, `translations`, `latest` and `long`, so article
// descriptions and related-content arrays vanished from the capture ("Wrong granularity
// match", reference/defects.md). A key is split into words at camelCase humps and at
// every non-alphanumeric: `latLng` -> lat, lng; `utm_source` -> utm, source;
// `userAgent` -> user, agent (deleted on purpose: it is a device identifier).
const SCRUB_WORDS = new Set([
  'session', 'visitor', 'device', 'user', 'account', 'swid', 'guid', 'geo', 'geoip',
  'geolocation', 'zip', 'zipcode', 'postal', 'postcode', 'postalcode', 'lat', 'latitude',
  'lon', 'lng', 'longitude', 'ip', 'ipaddress', 'dma', 'region', 'favorite', 'favourite',
  'utm', 'fbclid', 'gclid', 'cookie',
]);
const SCRUB_PREFIXES = ['personaliz', 'personalis', 'recommend'];
const keyWords = k => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const singular = w => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);
const scrubKey = k => keyWords(k).some(w =>
  SCRUB_WORDS.has(w) || SCRUB_WORDS.has(singular(w)) || SCRUB_PREFIXES.some(p => w.startsWith(p)));

// Values are scanned too (capture-rules.md "Scan values too"). An email or phone number
// inside a string is cut out of it; a string that IS a token (a JWT, or a long opaque
// run with no spaces or slashes) is deleted with its key.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
// Opaque secrets only: a JWT, or a 32+ char run with no hyphens (so slugs and canonical
// UUIDs survive) that mixes digits with BOTH letter cases (so hex content ids and hashes
// survive), or long padded base64. Session and device ids are already removed by key.
const TOKEN = /^(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[a-z])(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{32,}={0,2}|[A-Za-z0-9+/]{40,}={1,2})$/;
const DROP = Symbol('drop');
const scrubLog = [];
function scrub(v, path = '$') {
  if (Array.isArray(v)) {
    return v.map((x, i) => scrub(x, `${path}[${i}]`)).filter(x => x !== DROP);
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (scrubKey(k)) { scrubLog.push({ path: `${path}.${k}`, key: k, action: 'deleted' }); continue; }
      const clean = scrub(val, `${path}.${k}`);
      if (clean !== DROP) out[k] = clean;
    }
    return out;
  }
  if (typeof v === 'string') {
    if (TOKEN.test(v)) { scrubLog.push({ path, action: 'value-deleted', reason: 'token' }); return DROP; }
    let out = v;
    if (/[?&](utm_[a-z]+|fbclid|gclid)=/i.test(out)) {
      out = out.split('?')[0];
      scrubLog.push({ path, action: 'query-stripped' });
    }
    for (const [re, reason] of [[EMAIL, 'email'], [PHONE, 'phone']]) {
      if (re.test(out)) {
        out = out.replace(re, '');
        scrubLog.push({ path, action: 'value-redacted', reason });
      }
      re.lastIndex = 0;
    }
    return out;
  }
  return v;
}

const T0 = new Date().toISOString();
const STAMP = T0.replace(/[:.]/g, '-');
mkdirSync(ROOT, { recursive: true });
writeFileSync(ROOT + '/T0.txt', T0 + '\n');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

// ---- determinism lock (RL_BUILD Part 2) --------------------------------
// Viewport, timezone, animation playback, frozen clock and randomness, and the no-motion
// CSS, registered for every document this page loads (lib/lock.mjs).
await applyLock(cdp, T0);
await cdp.send('Network.enable');
// Ads + analytics only; the list and why first-party auth hosts stay off it live in
// lib/block-list.mjs.
await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });

// Whatever the block list does kill is recorded, so a later "not captured" verdict can
// be checked against it instead of being taken at face value.
const blocked = [];
cdp.on('Network.loadingFailed', e => {
  if (e.blockedReason) blocked.push({ reason: e.blockedReason, requestId: e.requestId });
});

const summary = [];

for (const [key, url] of PAGES) {
  const dir = `${ROOT}/raw/${STAMP}/${key}`;
  mkdirSync(dir + '/xhr', { recursive: true });
  mkdirSync(dir + '/globals', { recursive: true });

  const responses = [];
  const onResp = async (resp) => {
    const u = resp.url();
    if (RECORD_SKIP.some(re => re.test(u))) return;
    const rt = resp.request().resourceType();
    if (!['xhr','fetch','document'].includes(rt)) return;
    let body = null;
    try { body = await resp.text(); } catch { /* opaque */ }
    responses.push({ url: u.split('?')[0], query: u.includes('?') ? '(stripped)' : null,
                     method: resp.request().method(), status: resp.status(), type: rt,
                     bytes: body ? body.length : 0, body });
  };
  page.on('response', onResp);

  const started = new Date().toISOString();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(2500);

  // 2.1 document at rest
  writeFileSync(`${dir}/document.rest.html`, await page.content());

  // 2.4 interaction pass: scroll to end (feed is a fixed list per surface-census)
  await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let last = -1;
    for (let i = 0; i < 25; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(600);
      const h = document.body.scrollHeight;
      if (h === last) break;
      last = h;
    }
    window.scrollTo(0, 0); await sleep(400);
  });
  await page.waitForTimeout(1500);
  writeFileSync(`${dir}/document.scrolled.html`, await page.content());

  // 2.2 globals
  const globals = await page.evaluate(() => {
    const out = {};
    // `k.startsWith('__')` was the filter here, and it captured exactly two junk
    // globals while skipping `window.espn` -- ESPN's actual page-data global (nav,
    // scoreboard, i18n). RECON's "there is no page-data global" came from this line,
    // not from the reference. Serialize every own object global that is not a DOM
    // node or a framework internal.
    const SKIP = /^(document|location|navigator|history|screen|frames|top|parent|self|window|globalThis|performance|localStorage|sessionStorage|caches|crypto|console|customElements|visualViewport|speechSynthesis|indexedDB|external|clientInformation|styleMedia|trustedTypes)$/;
    for (const k of Object.keys(window)) {
      if (SKIP.test(k)) continue;
      const v = window[k];
      if (!v || typeof v !== 'object') continue;
      if (v instanceof Node || v instanceof Window || v instanceof Storage) continue;
      try { const j = JSON.stringify(v); if (j && j.length > 2) out[k] = JSON.parse(j); }
      catch { out[k] = '(uncloneable)'; }
    }
    return out;
  });
  for (const [k, v] of Object.entries(globals))
    writeFileSync(`${dir}/globals/${k.replace(/[^\w.-]/g,'_')}.json`, JSON.stringify(scrub(v, `$.${k}`), null, 2));

  // 2.5 visible text nodes
  const textNodes = await page.evaluate(() => {
    const clean = s => (s||'').replace(/\s+/g,' ').trim();
    const pathOf = el => { const p=[]; for (let e=el; e && e!==document.body; e=e.parentElement) {
      const c = typeof e.className==='string' && e.className.trim() ? '.'+e.className.trim().split(/\s+/)[0] : '';
      p.unshift(e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+c); if (p.length>6) break; } return p.join('>'); };
    const modOf = el => { const m = el.closest('#global-nav,.sub-module,.headlineStack,.contentItem,.scoreCollection,footer,.col-one,.col-two,.col-three');
      if (!m) return 'other'; if (m.id==='global-nav') return 'nav';
      const c = typeof m.className==='string' ? m.className.split(/\s+/)[0] : ''; return c || m.tagName.toLowerCase(); };
    const out=[]; const w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    const NONTEXT = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','IFRAME']);
    while ((n=w.nextNode())) { const t=clean(n.nodeValue); if(!t) continue;
      const el=n.parentElement; if(!el) continue;
      if (NONTEXT.has(el.tagName)) continue;                 // not user-visible text
      const r=el.getBoundingClientRect();
      out.push({ text:t, module:modOf(el), path:pathOf(el), visibleAtRest: !(r.width===0&&r.height===0) }); }
    return out;
  });
  writeFileSync(`${dir}/text-nodes.jsonl`, textNodes.map(o => JSON.stringify(o)).join('\n'));

  // 2.6 images
  const images = await page.evaluate(({ A2, KEEP }) => {
    const ex = new Set(document.querySelectorAll(A2));
    document.querySelectorAll(KEEP).forEach(e => ex.delete(e));
    const inEx = el => { for (let e=el; e && e!==document.body; e=e.parentElement) if (ex.has(e)) return true; return false; };
    const out=[];
    document.querySelectorAll('img').forEach(i => out.push({ kind:'img', a2Excluded: inEx(i), url:(i.currentSrc||i.src||''),
      alt:i.alt||'', natural:[i.naturalWidth,i.naturalHeight],
      rendered:[Math.round(i.getBoundingClientRect().width),Math.round(i.getBoundingClientRect().height)] }));
    document.querySelectorAll('*').forEach(e => { const b=getComputedStyle(e).backgroundImage;
      if (b && b!=='none' && b.includes('url(')) out.push({ kind:'bg', url:b.slice(4,-1).replace(/["']/g,'') }); });
    document.querySelectorAll('svg use').forEach(u => out.push({ kind:'use', url:u.getAttribute('href')||u.getAttribute('xlink:href')||'' }));
    return out.filter(o=>o.url);
  }, { A2: A2_SELECTOR, KEEP: A2_KEEP });
  writeFileSync(`${dir}/images.jsonl`, images.map(o => JSON.stringify(o)).join('\n'));

  // 2.7 per-module computed styles
  const styles = await page.evaluate(() => {
    const out={};
    document.querySelectorAll('#global-nav,.col-one,.col-two,.col-three,.sub-module,.headlineStack,.scoreCollection').forEach((e,i) => {
      const cs=getComputedStyle(e); const r=e.getBoundingClientRect();
      const cls = typeof e.className==='string'?e.className.trim().split(/\s+/).slice(0,2).join('.'):'';
      out[(e.id?'#'+e.id:'')+(cls?'.'+cls:'')+'#'+i] = {
        box:[Math.round(r.x),Math.round(r.y+scrollY),Math.round(r.width),Math.round(r.height)],
        display:cs.display, gridTemplateColumns:cs.gridTemplateColumns, flexDirection:cs.flexDirection,
        font:cs.font, fontFamily:cs.fontFamily, fontSize:cs.fontSize, lineHeight:cs.lineHeight,
        color:cs.color, background:cs.backgroundColor, padding:cs.padding, margin:cs.margin }; });
    return out;
  });
  writeFileSync(`${dir}/styles.modules.json`, JSON.stringify(styles, null, 2));

  // 2.3 xhr bodies (scrubbed)
  page.off('response', onResp);
  responses.forEach((r, i) => {
    const slug = r.url.replace(/^https?:\/\//,'').replace(/[^\w.-]/g,'_').slice(0, 70);
    const meta = { url:r.url, method:r.method, status:r.status, type:r.type, bytes:r.bytes, capturedAt:started };
    writeFileSync(`${dir}/xhr/${String(i).padStart(3,'0')}.${r.method}.${slug}.meta.json`, JSON.stringify(meta,null,2));
    if (r.body) {
      let out = r.body;
      try { out = JSON.stringify(scrub(JSON.parse(r.body), `$.${slug}`), null, 2); } catch {}
      writeFileSync(`${dir}/xhr/${String(i).padStart(3,'0')}.${r.method}.${slug}.json`, out);
    }
  });

  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
                                          docH: document.body.scrollHeight }));
  summary.push({ page:key, url, started, ended:new Date().toISOString(),
                 viewport:`${vp.w}x${vp.h}@${vp.dpr}`, docHeight:vp.docH,
                 textNodes:textNodes.length, images:images.length, xhr:responses.length,
                 globals:Object.keys(globals).length, styleModules:Object.keys(styles).length });
  console.log(`${key.padEnd(6)} vp ${vp.w}x${vp.h}@${vp.dpr}  doc ${vp.docH}  text ${textNodes.length}  img ${images.length}  xhr ${responses.length}  globals ${Object.keys(globals).length}`);
}

writeFileSync(`${ROOT}/raw/${STAMP}/_summary.json`, JSON.stringify({ T0, summary }, null, 2));
writeFileSync(`${ROOT}/scrub-log.jsonl`, scrubLog.map(o => JSON.stringify(o)).join('\n'));
// Persisted beside the snapshot so a later NOT CAPTURED verdict can be checked against it.
writeFileSync(`${ROOT}/raw/${STAMP}/blocked.jsonl`, blocked.map(o => JSON.stringify(o)).join('\n'));
console.log(`\nT0 ${T0}`);
console.log(`scrub deletions: ${scrubLog.length}`);
console.log(`blocked requests: ${blocked.length} -> scrape/raw/${STAMP}/blocked.jsonl`);
console.log(`raw -> scrape/raw/${STAMP}/`);
await page.close();
await browser.close();
