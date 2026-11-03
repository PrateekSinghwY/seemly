// PAGE COMPLETE (ASSUMPTIONS A13).
//
// A route is DONE only when every unmasked module reports 0 differing pixels against its
// T0 oracle clip, header to footer, and every oracle region has a clone module under it.
// Prints a page x module table and fails on any non-zero unmasked module.
//
// The clone is rendered the way the oracle was: the SAME Chrome build (the persistent
// profile over CDP, as pixel-diff.mjs does; `chromium.launch()` runs the separate
// headless-shell build, whose font rasterization differs, so no text module could reach
// 0 pixels), the same viewport lock, the same third-party block list and the same A2
// redaction. It refuses, recorded as not-run, when the measured lock is not the oracle's.
//
// Skips cleanly when the capture or the app is absent; never reports a pass for a page
// it did not actually compare.
import { chromium } from 'playwright';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { PNG } from 'pngjs';
import { clipName, assertUniqueClipNames } from '../lib/clip-name.mjs';
import { latestStamp } from '../lib/snapshot.mjs';
import { LOCK_VIEWPORT } from '../lib/lock.mjs';
import { BLOCKED_URLS } from '../lib/block-list.mjs';
import { redactA2 } from '../lib/a2-redact.mjs';
import { writeCheckRecord } from '../lib/check-record.mjs';

const DISCOVERY = 'never_to_be_pushed/discovery/scrape';
const BASE = process.env.CLONE_BASE || 'http://localhost:3000';
const CDP = process.env.ORACLE_CDP || 'http://127.0.0.1:9222';
const ROUTES = [['home', '/'], ['nfl', '/nfl'], ['ncaaf', '/college-football'], ['nba', '/nba'], ['wnba', '/wnba']];
const DPR = LOCK_VIEWPORT.deviceScaleFactor;

const REPORT = 'never_to_be_pushed/discovery/pixel-reports/_page_complete.json';
mkdirSync('never_to_be_pushed/discovery/pixel-reports', { recursive: true });
// A gate that could not run must not look like a gate that ran and passed: the sweep
// reads `ran` from checks/page_complete.json rather than trusting the exit code
// (LESSONS #22). The per-route detail stays in pixel-reports/_page_complete.json.
const record = (ran, reason, routes, status = ran ? 'pass' : 'skipped') => {
  writeFileSync(REPORT, JSON.stringify({ ran, reason, at: new Date().toISOString(), routes }, null, 2));
  writeCheckRecord('page_complete', { ran, count: routes.length, status, reason });
};

const STAMP = latestStamp(DISCOVERY);
if (!STAMP) {
  record(false, 'no capture on disk', []);
  console.log('check_page_complete: no capture — SKIPPED (recorded as not-run)'); process.exit(0);
}

try { const r = await fetch(BASE + '/'); if (!r.ok) throw new Error(String(r.status)); }
catch {
  record(false, `no app served at ${BASE}`, []);
  console.log(`check_page_complete: no app at ${BASE} — SKIPPED (recorded as not-run)`);
  process.exit(0);
}

// A crash between here and the final record() would leave the previous run's `ran: true`
// on disk and a failed gate would read as a passed one. Claim not-run up front; the
// finished path overwrites it.
record(false, 'comparison started but did not finish', []);

let browser;
try { browser = await chromium.connectOverCDP(CDP); }   // same Chrome build as the oracle
catch {
  record(false, `no oracle Chrome at ${CDP}`, []);
  console.log(`check_page_complete: no oracle Chrome at ${CDP} — SKIPPED (recorded as not-run); start it with launch-profile.mjs`);
  process.exit(0);
}
const ctx = browser.contexts()[0];
const results = [];

for (const [key, route] of ROUTES) {
  const dir = `${DISCOVERY}/raw/${STAMP}/${key}/pixels`;
  if (!existsSync(`${dir}/_modules.json`)) { results.push({ key, error: 'no oracle module list' }); continue; }
  const oracle = JSON.parse(readFileSync(`${dir}/_modules.json`, 'utf8'));
  try { assertUniqueClipNames(oracle.regions); }
  catch (e) { results.push({ key, error: e.message }); continue; }

  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', LOCK_VIEWPORT);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});

  const lock = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  if (lock.w !== LOCK_VIEWPORT.width || lock.h !== LOCK_VIEWPORT.height || lock.dpr !== DPR) {
    await page.close(); await browser.close();
    const why = `lock mismatch on ${key}: ${lock.w}x${lock.h}@${lock.dpr}, oracle is ${LOCK_VIEWPORT.width}x${LOCK_VIEWPORT.height}@${DPR}`;
    record(false, why, []);
    console.log(`check_page_complete: REFUSING — ${why} (recorded as not-run)`);
    process.exit(1);
  }
  await page.addStyleTag({ content: `*,*::before,*::after{animation:none!important;transition:none!important;
    animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important}` });
  await redactA2(page);
  // settle lazy content the same way the oracle did
  await page.evaluate(async () => { const s = ms => new Promise(r => setTimeout(r, ms));
    let last = -1; for (let i = 0; i < 30; i++) { window.scrollTo(0, document.body.scrollHeight); await s(500);
      const h = document.body.scrollHeight; if (h === last) break; last = h; } window.scrollTo(0, 0); await s(500); });

  const shot = `never_to_be_pushed/discovery/pixel-reports/${key}.page.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const clone = await page.evaluate(() => ({ height: document.body.scrollHeight }));
  await page.close();

  const act = PNG.sync.read(readFileSync(shot));
  const rows = [];
  for (const r of oracle.regions) {
    if (r.masked) { rows.push({ module: r.title || r.sig, status: 'MASKED', diff: null }); continue; }
    const file = `${dir}/${clipName(r)}`;
    if (!existsSync(file)) { rows.push({ module: r.title || r.sig, status: 'NO CLIP', diff: null }); continue; }
    const exp = PNG.sync.read(readFileSync(file));
    const x0 = r.box[0] * DPR, y0 = r.box[1] * DPR;
    let diff = 0, compared = 0;
    for (let y = 0; y < exp.height; y++) for (let x = 0; x < exp.width; x++) {
      const ax = x0 + x, ay = y0 + y;
      if (ax >= act.width || ay >= act.height) { diff++; continue; }
      const i = (y * exp.width + x) * 4, j = (ay * act.width + ax) * 4;
      compared++;
      if (Math.abs(exp.data[i] - act.data[j]) > 8 || Math.abs(exp.data[i+1] - act.data[j+1]) > 8
       || Math.abs(exp.data[i+2] - act.data[j+2]) > 8) diff++;
    }
    rows.push({ module: r.title || r.sig, status: diff === 0 ? 'OK' : 'DIFF', diff, compared });
  }
  results.push({ key, route, rows, oracleHeight: oracle.baselineHeight, cloneHeight: clone.height,
                 coverage: oracle.coveragePct });
}
await browser.close();   // disconnects; the oracle's Chrome keeps running

let failed = 0;
for (const res of results) {
  console.log(`\n  ${res.key}  ${res.route ?? ''}`);
  if (res.error) { console.log(`    ${res.error}`); failed++; continue; }
  console.log(`    oracle height ${res.oracleHeight}px · clone height ${res.cloneHeight}px · oracle coverage ${res.coverage}%`);
  for (const r of res.rows) {
    const d = r.diff === null ? '' : `${r.diff} px`;
    console.log(`      ${String(r.module).slice(0, 36).padEnd(38)} ${r.status.padEnd(8)} ${d}`);
    if (r.status === 'DIFF' || r.status === 'NO CLIP') failed++;
  }
  if (typeof res.coverage !== 'number' || !Number.isFinite(res.coverage)) {
    console.log(`      MISSING COVERAGE: oracle reported no coverage figure (${res.coverage})`); failed++;
  } else if (res.coverage < 100) { console.log(`      ORACLE HOLE: ${(100 - res.coverage).toFixed(1)}% of the page is in no module`); failed++; }
}

record(true, failed ? `${failed} module/coverage problem(s)` : null, results.map(r => ({ route: r.key, coverage: r.coverage,
  modules: (r.rows || []).length,
  ok: (r.rows || []).filter(x => x.status === 'OK').length,
  diff: (r.rows || []).filter(x => x.status === 'DIFF').length,
  noClip: (r.rows || []).filter(x => x.status === 'NO CLIP').length })), failed ? 'fail' : 'pass');
console.log(`\ncheck_page_complete: ${results.length} route(s)`);
if (failed) { console.log(`FAIL: ${failed} module/coverage problem(s) — PAGE COMPLETE not met`); process.exit(1); }
console.log('PASS: every unmasked module matches its oracle exactly');
