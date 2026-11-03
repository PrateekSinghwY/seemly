// Pixel channel (ESPN_BUILD). Per-module diff of the clone against the T0 oracle.
//   node scripts/pixel-diff.mjs <page> [--url http://localhost:3000/...]
// Masks come from the oracle's per-page regions.json plus pixel-drift.json, and the
// SAME Chrome build drives both sides (the oracle's persistent profile over CDP).
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { PNG } from 'pngjs';
import { clipName, assertUniqueClipNames } from '../lib/clip-name.mjs';
import { redactA2 } from '../lib/a2-redact.mjs';
import { BLOCKED_URLS } from '../lib/block-list.mjs';

const DISCOVERY = 'never_to_be_pushed/discovery/scrape';
const STAMP = existsSync(`${DISCOVERY}/raw`) ? readdirSync(`${DISCOVERY}/raw`).sort().reverse()[0] : null;
const page_ = process.argv[2];
const urlArg = (process.argv.find(a => a.startsWith('--url=')) || '').split('=')[1];
const CLONE = { home: '/', nfl: '/nfl/', ncaaf: '/college-football/', nba: '/nba/', wnba: '/wnba/' };

if (!page_ || !CLONE[page_]) {
  console.error('usage: node scripts/pixel-diff.mjs <home|nfl|ncaaf|nba|wnba> [--url=...]');
  process.exit(2);
}
if (!STAMP) { console.error('no oracle: run the scrape first'); process.exit(2); }

const oracleDir = `${DISCOVERY}/raw/${STAMP}/${page_}/pixels`;
const regions = JSON.parse(readFileSync(`${oracleDir}/regions.json`, 'utf8')).regions;
// Regions are recorded in CSS pixels; both shots are at deviceScaleFactor 2.
const maskBoxes = regions.map(r => [r.x * 2, r.y * 2, (r.x + r.w) * 2, (r.y + r.h) * 2]);
const maskAt = (x, y) => {
  for (const [x0, y0, x1, y1] of maskBoxes) {
    if (x >= x0 && x < x1 && y >= y0 && y < y1) return true;
  }
  return false;
};
const drift = JSON.parse(readFileSync(`${DISCOVERY}/pixel-drift.json`, 'utf8')).filter(d => d.page === page_);

const target = urlArg || `http://localhost:3000${CLONE[page_]}`;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');   // same Chrome build as the oracle
const ctx = browser.contexts()[0];
const p = await ctx.newPage();
const cdp = await ctx.newCDPSession(p);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
// Same determinism lock the oracle ran under, or the two sides are not comparable:
// third parties blocked (they also never let networkidle settle on the reference).
await cdp.send('Network.enable');
await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });

await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
await p.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
await p.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
await p.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;
  animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}` });
// A2 redaction on THIS side too, from the single definition (lib/a2-redact.mjs).
await redactA2(p);

// settle lazy content the same way the oracle did
await p.evaluate(async () => { const s = ms => new Promise(r => setTimeout(r, ms));
  let last = -1; for (let i = 0; i < 30; i++) { window.scrollTo(0, document.body.scrollHeight); await s(500);
    const h = document.body.scrollHeight; if (h === last) break; last = h; } window.scrollTo(0, 0); await s(500); });

mkdirSync('never_to_be_pushed/discovery/pixel-reports', { recursive: true });

// PER-MODULE, not full-page. A whole-page diff is meaningless here: the feed pages on
// scroll, so full-page height varies run to run (58590 vs 14274 device px observed on
// the same URL). Modules are located by dom_signature on BOTH sides, so a height change
// in one module cannot smear across the rest of the report.
const mods = await p.evaluate(() => {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const push = (el, column, order) => {
    const r = el.getBoundingClientRect();
    if (r.height < 20 || r.width < 40) return;
    if (el.hasAttribute('data-oracle-redact')) return;          // A2, same as the oracle
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    const h = el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
    out.push({ column, order,
               sig: el.tagName.toLowerCase() + '.' + cls.split(/\s+/).slice(0, 2).join('.'),
               title: clean(h && h.innerText).slice(0, 60) || null,
               box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] });
  };
  // the shell, which the oracle now carries clips for
  const shellHeader = document.querySelector('header') || document.querySelector('nav');
  if (shellHeader) {
    const r = shellHeader.getBoundingClientRect();
    if (r.height >= 20) out.push({ column: 'shell', order: 0, sig: 'shell-header', title: 'shell-header',
      box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] });
  }
  const feed = document.querySelector('.col-two'); if (feed) push(feed, 'col-two', 0);
  ['.col-one', '.col-three'].forEach(cs => { const c = document.querySelector(cs); if (!c) return;
    [...c.children].forEach((el, i) => push(el, cs.replace('.', ''), i)); });
  return out;
});

const lock = await p.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
console.log(`pixel-diff lock: ${lock.w}x${lock.h} @${lock.dpr}x  (oracle: 1440x900 @2x)`);
if (lock.w !== 1440 || lock.h !== 900 || lock.dpr !== 2) {
  console.error(`REFUSING: clone viewport is ${lock.w}x${lock.h}@${lock.dpr}, oracle requires exactly 1440x900@2 — not comparable`);
  process.exit(2);
}

const actualPath = `never_to_be_pushed/discovery/pixel-reports/${page_}.actual.png`;
await p.screenshot({ path: actualPath, fullPage: true });
await p.close(); await browser.close();

// per-module compare: match the oracle clip for each module by signature+title
const read = f => PNG.sync.read(readFileSync(f));
const act = read(actualPath);
const clips = readdirSync(oracleDir).filter(f => f.endsWith('.png') && f !== 'full.png');

// A module whose clone box and oracle clip differ in size by more than this fraction, or
// that overlaps the clone screenshot by less than this, is a FAIL: comparing only the
// overlapping corner would pass a module that is half missing.
const COVERAGE_TOLERANCE = 0.02;

const driftedFeed = drift.some(d => /contentFeed|col-two/.test(d.now || ''));

assertUniqueClipNames(mods);
const rows = [];
for (const m of mods) {
  const want = clipName(m);
  const file = clips.includes(want) ? want : null;   // exact match, one definition
  const isFeed = m.column === 'col-two';
  if (isFeed && driftedFeed) { rows.push({ module: m.title || m.sig, status: 'MASKED (pixel-drift)' }); continue; }
  if (!file) { rows.push({ module: m.title || m.sig, status: 'NO ORACLE CLIP' }); continue; }
  const exp = read(`${oracleDir}/${file}`);
  const expW = exp.width, expH = exp.height;
  const actW = Math.round(m.box[2] * 2), actH = Math.round(m.box[3] * 2);
  if (!(expW > 0 && expH > 0 && actW > 0 && actH > 0)) {
    rows.push({ module: m.title || m.sig, oracleClip: file, expected: [expW, expH], actual: [actW, actH],
                status: 'FAIL', reason: 'missing expected/actual dimensions' });
    continue;
  }
  const W = Math.min(expW, actW);
  const H = Math.min(expH, actH);
  let diff = 0, compared = 0, maskedOut = 0;
  const ox = Math.round(m.box[0] * 2), oy = Math.round(m.box[1] * 2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ax = ox + x, ay = oy + y;
    if (ax >= act.width || ay >= act.height) continue;
    // regions.json is in CSS pixels; the shots are deviceScaleFactor 2. A pixel inside
    // any redacted region is skipped rather than compared: these cover ad slots and the
    // account-bound modules, which have no counterpart in the clone. Loading the regions
    // and never consulting them meant every masked pixel counted as a difference.
    if (maskAt(ax, ay)) { maskedOut++; continue; }
    const i = (y * exp.width + x) * 4, j = (ay * act.width + ax) * 4;
    compared++;
    if (Math.abs(exp.data[i] - act.data[j]) > 8 || Math.abs(exp.data[i+1] - act.data[j+1]) > 8
     || Math.abs(exp.data[i+2] - act.data[j+2]) > 8) diff++;
  }
  const pct = compared ? diff / compared * 100 : 0;
  const expArea = expW * expH, actArea = actW * actH;
  // Masked pixels are excluded from the denominator too: they are not gaps in
  // coverage, they are areas deliberately not compared.
  const comparable = Math.max(expArea, actArea) - maskedOut;
  const coverage = comparable > 0 ? compared / comparable : 0;
  const areaDelta = Math.abs(expArea - actArea) / Math.max(expArea, actArea);
  let reason = null;
  if (compared === 0) reason = 'compared coverage is zero';
  else if (areaDelta > COVERAGE_TOLERANCE) reason = `size differs by ${(areaDelta * 100).toFixed(1)}% (tolerance ${COVERAGE_TOLERANCE * 100}%)`;
  else if (1 - coverage > COVERAGE_TOLERANCE) reason = `only ${(coverage * 100).toFixed(1)}% of the module was compared`;
  rows.push({ module: m.title || m.sig, oracleClip: file, expected: [expW, expH], actual: [actW, actH],
              pixelsCompared: compared, pixelsMasked: maskedOut,
              coverage: +(coverage * 100).toFixed(2),
              pixelsDiffering: diff, percentDiffering: +pct.toFixed(3),
              status: !reason && pct < 1 ? 'PASS' : 'FAIL', ...(reason ? { reason } : {}) });
}
const failed = rows.filter(r => r.status === 'FAIL');
const pct = rows.length ? failed.length / rows.length * 100 : 0;
const report = { page: page_, target, oracleDir, modules: rows.length,
  passed: rows.filter(r => r.status === 'PASS').length,
  failed: failed.length,
  masked: rows.filter(r => r.status.startsWith('MASKED')).length,
  noOracleClip: rows.filter(r => r.status === 'NO ORACLE CLIP').length,
  maskedRegions: regions.length, driftMaskedModules: drift.length, rows };
writeFileSync(`never_to_be_pushed/discovery/pixel-reports/${page_}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

// A comparison that compared nothing is not a pass. The clone renders zero-height
// placeholder modules until slice 4 fills them, and reporting 0/0/0 as success is the
// same vacuous-verdict shape the A2 check had.
if (rows.length === 0) {
  console.log("\nEMPTY: no modules were compared — the clone rendered none at this route.");
  process.exit(2);
}
process.exit(failed.length === 0 ? 0 : 1);
