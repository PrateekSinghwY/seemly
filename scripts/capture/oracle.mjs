// SCRAPE 2.9 - the pixel oracle. Full-page + per-module + interaction states for all
// five pages, at the canonical viewport, under the determinism lock, redact-then-shoot.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { clipName } from '../lib/clip-name.mjs';
import { redactA2 } from '../lib/a2-redact.mjs';
import { BLOCKED_URLS } from '../lib/block-list.mjs';
import { latestStamp } from '../lib/snapshot.mjs';
import { PNG } from 'pngjs';
const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo

const ROOT  = REPO + '/never_to_be_pushed/discovery/scrape';
const STAMP = latestStamp(ROOT);
if (!STAMP) { console.error('no capture: run capture.mjs first'); process.exit(2); }
const PAGES = [
  ['home','https://www.espn.com/'], ['nfl','https://www.espn.com/nfl/'],
  ['ncaaf','https://www.espn.com/college-football/'], ['nba','https://www.espn.com/nba/'],
  ['wnba','https://www.espn.com/wnba/'],
];

// T0 truth to diff against
const t0Modules = readFileSync(`${ROOT}/normalized/page_module.jsonl`,'utf8').split('\n').filter(Boolean).map(JSON.parse);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

// determinism lock
await cdp.send('Emulation.setDeviceMetricsOverride', { width:1440, height:900, deviceScaleFactor:2, mobile:false });
await cdp.send('Network.enable');
await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });

const drift = [];
const shots = [];

for (const [key, url] of PAGES) {
  const dir = `${ROOT}/raw/${STAMP}/${key}/pixels`;
  rmSync(dir, { recursive: true, force: true });   // stale clips from a prior run are not a baseline
  mkdirSync(dir, { recursive: true });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 40000 }).catch(()=>{});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(()=>{});
  await page.addStyleTag({ content:
    `*,*::before,*::after{animation:none!important;transition:none!important;animation-duration:0s!important;
     transition-duration:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}` });

  // settle lazy content, then return to top
  await page.evaluate(async () => { const s=ms=>new Promise(r=>setTimeout(r,ms));
    let last=-1; for (let i=0;i<30;i++){ window.scrollTo(0,document.body.scrollHeight); await s(500);
      const h=document.body.scrollHeight; if(h===last) break; last=h; } window.scrollTo(0,0); await s(500); });

  // A2 redaction, verified before any shutter
  const redact = await redactA2(page);
  await page.waitForTimeout(400);
  const leak = await page.evaluate(() => [...document.querySelectorAll('[data-oracle-redact]')]
    .filter(e => getComputedStyle(e).visibility !== 'hidden').length);
  if (leak > 0) { console.log(`${key}: REDACTION LEAK ${leak} - skipping shutter`); continue; }

  // full page
  await page.screenshot({ path: `${dir}/full.png`, fullPage: true });
  shots.push(`${key}/pixels/full.png`);

  // per-module clips + drift vs T0
  const mods = await page.evaluate(() => {
    const clean=s=>(s||'').replace(/\s+/g,' ').trim();
    const out=[];
    const push=(el,column,order)=>{ const r=el.getBoundingClientRect();
      if(r.height<20||r.width<40) return;
      if(el.hasAttribute('data-oracle-redact')) return;
      const cls=typeof el.className==='string'?el.className.trim():'';
      const h=el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      // same construction as tools/normalize.mjs: tag + first two classes, NO id
      out.push({ column, order, sig: el.tagName.toLowerCase()+'.'+cls.split(/\s+/).slice(0,2).join('.'),
                 title: clean(h&&h.innerText).slice(0,60)||null,
                 box:[Math.round(r.left),Math.round(r.top+scrollY),Math.round(r.width),Math.round(r.height)],
                 items: el.querySelectorAll('.contentItem').length });
    };
    const feed=document.querySelector('.col-two'); if(feed) push(feed,'col-two',0);
    ['.col-one','.col-three'].forEach(cs=>{const c=document.querySelector(cs); if(!c)return;
      [...c.children].forEach((el,i)=>push(el,cs.replace('.',''),i));});
    return out;
  });

  // Crop clips out of full.png rather than re-shooting: page.screenshot({clip}) clips
  // against the VIEWPORT, so every module below 900px failed with "Clipped area is
  // outside the resulting image". Cropping also guarantees each clip is exactly a
  // sub-rectangle of the baseline it will be compared against.
  const clipFails = [];
  const fullImg = PNG.sync.read(readFileSync(`${dir}/full.png`));
  const DPR = 2;
  for (const m of mods) {
    const name = clipName(m);
    const x = Math.max(0, Math.round(m.box[0] * DPR));
    const y = Math.max(0, Math.round(m.box[1] * DPR));
    const w = Math.min(Math.round(m.box[2] * DPR), fullImg.width  - x);
    const h = Math.min(Math.round(m.box[3] * DPR), fullImg.height - y);
    if (w <= 0 || h <= 0) {
      clipFails.push({ module: m.title || m.sig, box: m.box, error: `out of baseline bounds (${fullImg.width}x${fullImg.height})` });
      continue;
    }
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(fullImg, out, x, y, w, h, 0, 0);
    writeFileSync(`${dir}/${name}`, PNG.sync.write(out));
  }
  if (clipFails.length) {
    console.log(`  ${key}: ${clipFails.length} clip(s) FAILED`);
    clipFails.forEach(f => console.log(`     ${f.module?.slice(0,40)} box=${f.box} :: ${f.error}`));
  }
  writeFileSync(`${dir}/_clips.json`, JSON.stringify(
    { written: mods.length - clipFails.length, failed: clipFails }, null, 2));

  // drift: module present at T0 but changed title / item count now
  const t0 = t0Modules.filter(m => m.page_key === key);
  for (const m of mods) {
    const norm = v => (v || '').replace(/-\d{3,}(?=\.|$)/, '');
    const match = t0.find(x => norm(x.dom_signature) === norm(m.sig) && (x.title || null) === (m.title || null));
    if (!match) {
      drift.push({ page: key, module: m.title || m.sig, kind: 'not-in-T0', now: m.sig });
    } else if (m.items && match.item_count && m.items !== match.item_count) {
      drift.push({ page: key, module: m.title || m.sig, kind: 'item-count',
                   t0: match.item_count, now: m.items });
    }
  }
  console.log(`${key.padEnd(6)} redacted ${String(redact.count).padStart(2)} leak 0  modules ${mods.length}  clips written`);
  writeFileSync(`${dir}/regions.json`, JSON.stringify({ page:key, viewport:'1440x900@2', regions: redact.regions }, null, 2));
}

writeFileSync(`${ROOT}/pixel-drift.json`, JSON.stringify(drift, null, 2));
console.log(`\nfull-page shots: ${shots.length}/5   drift rows: ${drift.length}`);
await page.close(); await browser.close();
