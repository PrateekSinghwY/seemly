// Full-page oracle coverage (ASSUMPTIONS A13).
//
// Enumerates every module region on each page from the T0 DOM and crops a clip for each
// out of the existing T0 full-page PNG. No re-shoot: the baseline stays the T0 pixels.
//
// Also reports COVERAGE: how much of the page's AREA is inside a listed module or a
// masked region (lib/coverage.mjs). Anything outside is a hole in the oracle list, which
// A13 calls a defect.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs';
import { PNG } from 'pngjs';
import { clipName } from '../lib/clip-name.mjs';
import { coverage2d } from '../lib/coverage.mjs';
import { A2_SELECTOR, A2_HEADING_SOURCE, A2_HEADING_SCOPE, A2_HEADING_NEVER, A2_KEEP }
  from '../lib/a2-selector.mjs';

const ROOT = 'never_to_be_pushed/discovery/scrape';
const STAMP = readdirSync(`${ROOT}/raw`).sort().reverse()[0];
const PAGES = ['home', 'nfl', 'ncaaf', 'nba', 'wnba'];
const DPR = 2;

const b = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const summary = [];

for (const page of PAGES) {
  const dir = `${ROOT}/raw/${STAMP}/${page}`;
  await p.goto(`file://${process.cwd()}/${dir}/document.scrolled.html`, { waitUntil: 'domcontentloaded' });

  const regions = await p.evaluate(({ SEL, HEAD, HEAD_SCOPE, HEAD_NEVER, KEEP }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const ex = new Set(document.querySelectorAll(SEL));
    document.querySelectorAll(KEEP).forEach(e => ex.delete(e));
    const HEADRE = new RegExp(HEAD, 'i');
    document.querySelectorAll(HEAD_SCOPE).forEach(m => {
      if (m.closest(HEAD_NEVER)) return;
      const h = m.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      if (h && HEADRE.test(clean(h.innerText))) ex.add(m);
    });
    const masked = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (ex.has(e)) return true; return false; };
    const box = el => { const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)]; };

    const out = [];
    const add = (el, column, order, forcedTitle) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) return;
      const cls = typeof el.className === 'string' ? el.className.trim() : '';
      const h = el.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      out.push({ column, order,
                 sig: el.tagName.toLowerCase() + '.' + cls.split(/\s+/).slice(0, 2).join('.'),
                 title: forcedTitle ?? (clean(h && h.innerText).slice(0, 60) || null),
                 masked: masked(el), box: box(el) });
    };

    // shell
    add(document.querySelector('#global-header') || document.querySelector('#global-nav'), 'shell', 0, 'shell-header');
    add(document.querySelector('.scoreboard-content') || document.querySelector('.scoreCollection'), 'shell', 1, 'shell-scores');

    // Full-width page bands between the shell and the columns — banner ad slots and any
    // other page-level strip. Enumerating only the three columns left an 84px hole.
    const cols = ['col-one', 'col-two', 'col-three'].map(c => document.querySelector('.' + c)).filter(Boolean);
    const insideCol = el => cols.some(c => c.contains(el));
    let bandIdx = 0;
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 1200 || r.height < 20 || r.height > 400) return;
      if (insideCol(el) || el.closest('#global-header') || el.closest('#global-nav')) return;
      if (el.querySelector('.col-one, .col-two, .col-three')) return;   // a wrapper, not a band
      if ([...el.children].some(c => c.getBoundingClientRect().width >= 1200 && c.getBoundingClientRect().height >= 20)) return;
      add(el, 'band', bandIdx++);
    });

    // columns and every module in them
    ['col-one', 'col-two', 'col-three'].forEach(c => {
      const col = document.querySelector('.' + c);
      if (!col) return;
      [...col.children].forEach((el, i) => add(el, c, i));
    });

    // The PAGE footer, not the first `footer` in the document: rail modules contain
    // their own small footers, and the first match was a 196x36 one inside a masked rail.
    const footers = [...document.querySelectorAll('footer')]
      .map(f => ({ f, r: f.getBoundingClientRect() }))
      .filter(x => x.r.width >= 1000)
      .sort((a, b) => b.r.height - a.r.height);
    add(footers[0]?.f, 'footer', 0, 'page-footer');
    // and its sub-blocks, so a 551px footer is not one opaque clip
    if (footers[0]) [...footers[0].f.children].forEach((el, i) => add(el, 'footer', i + 1));

    return { regions: out, docHeight: document.body.scrollHeight };
  }, { SEL: A2_SELECTOR, HEAD: A2_HEADING_SOURCE, HEAD_SCOPE: A2_HEADING_SCOPE, HEAD_NEVER: A2_HEADING_NEVER, KEEP: A2_KEEP });

  const pixDir = `${dir}/pixels`;
  const full = PNG.sync.read(readFileSync(`${pixDir}/full.png`));
  // keep full.png + regions.json, drop stale clips
  for (const f of readdirSync(pixDir)) if (f.endsWith('.png') && f !== 'full.png') rmSync(`${pixDir}/${f}`);

  let written = 0;
  for (const r of regions.regions) {
    if (r.masked) continue;
    const x = Math.max(0, r.box[0] * DPR), y = Math.max(0, r.box[1] * DPR);
    const w = Math.min(r.box[2] * DPR, full.width - x), h = Math.min(r.box[3] * DPR, full.height - y);
    if (w <= 0 || h <= 0) continue;
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(full, out, x, y, w, h, 0, 0);
    writeFileSync(`${pixDir}/${clipName(r)}`, PNG.sync.write(out));
    written++;
  }

  // Coverage is measured against the DOM we can enumerate, not the PNG's height.
  // The two disagree: the live capture's feed had paged further than the serialized
  // document replays, so the baseline PNG is taller than the DOM re-renders. Measuring
  // against the PNG would report a permanent hole that no module could ever fill.
  const baselineH = Math.round(full.height / DPR);
  const domH = regions.docHeight;
  const pageH = Math.min(domH, baselineH);
  // Area, not rows: a row-only measure reports 100% with a whole column missing.
  const cov = coverage2d(regions.regions, Math.round(full.width / DPR), pageH);
  // Floored, not rounded: 99.96% must not print as 100.0 and pass the gate.
  const pct = Math.floor(cov.pct * 10) / 10;
  const heightDelta = baselineH - domH;
  writeFileSync(`${pixDir}/_modules.json`, JSON.stringify({ page, docHeight: domH,
    baselineHeight: baselineH, measuredHeight: pageH, heightDelta,
    coveragePct: pct, coverageFrame: cov.frame,
    coverageHoles: cov.holes.slice(0, 50), regions: regions.regions }, null, 2));
  summary.push({ page, regions: regions.regions.length, clips: written,
                 masked: regions.regions.filter(r => r.masked).length, coverage: pct });
  console.log(`  ${page.padEnd(6)} regions ${String(regions.regions.length).padStart(3)}  clips ${String(written).padStart(3)}  masked ${String(regions.regions.filter(r=>r.masked).length).padStart(2)}  coverage ${pct.toFixed(1)}%  dom ${domH}px  baseline ${baselineH}px  delta ${heightDelta}px`);
}
console.log('\ncoverage below 100% means the oracle list has a hole (A13)');
await b.close();
