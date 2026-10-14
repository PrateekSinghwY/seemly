// Class 9 evidence: hold every in-scope page and count requests after settle.
// All five in parallel so the hold costs one wall-clock window, not five.
import { chromium } from 'playwright';

const PAGES = [
  ['home',  'https://www.espn.com/'],
  ['nfl',   'https://www.espn.com/nfl/'],
  ['ncaaf', 'https://www.espn.com/college-football/'],
  ['nba',   'https://www.espn.com/nba/'],
  ['wnba',  'https://www.espn.com/wnba/'],
];
const SETTLE_MS = 20000;   // ignore load + lazy tail
const HOLD_MS   = 100000;  // then watch

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

const runs = PAGES.map(async ([key, url]) => {
  const page = await ctx.newPage();
  const after = [];
  let settled = false;
  page.on('request', r => { if (settled) after.push(r.resourceType() + ' ' + r.url().split('?')[0]); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(SETTLE_MS);
  settled = true;
  await page.waitForTimeout(HOLD_MS);
  const ws = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(r => r.initiatorType === 'websocket').length);
  await page.close();
  // blob: media is video playback, not a data poll
  const firstParty = after.filter(u => /espn\.com|espncdn/.test(u) && !u.startsWith('media blob:'));
  return { key, heldMs: HOLD_MS, requestsAfterSettle: after.length,
           firstPartyAfterSettle: firstParty.length, websockets: ws,
           sample: firstParty.slice(0, 4) };
});

const out = await Promise.all(runs);
console.log(JSON.stringify(out, null, 2));
const polling = out.filter(o => o.firstPartyAfterSettle > 0).map(o => o.key);
console.log(polling.length ? `\nPOLLING DETECTED on: ${polling.join(', ')}`
                           : `\nNO POLLING on any of the ${out.length} in-scope pages (held ${HOLD_MS/1000}s each, in parallel)`);
await browser.close();
