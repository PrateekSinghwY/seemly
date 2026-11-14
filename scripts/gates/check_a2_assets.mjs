// A2 asset containment check.
//
// KNOWN LIMITATION: asset rows carry page_key but not the module they came from, so an
// asset used by both an excluded module and a public one cannot be attributed. This
// check therefore flags only assets that appear EXCLUSIVELY inside excluded modules.
// Adding a `module` column to `asset` would make attribution exact; logged in
// KNOWN_GAPS.md rather than bolted on mid-verification.
//
// Every seeded asset must come from a module that is NOT A2-excluded. This is checked
// against the captured DOM, not by keyword: "fantasy" in a URL proves nothing (the
// public Fantasy nav pillar legitimately ships icons), while an unmarked image inside
// the fantasy signup rail is a violation.
//
// Skips cleanly when discovery/ is absent (it is git-excluded, so CI will not have it).
import { chromium } from 'playwright';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { A2_SELECTOR, A2_HEADING_SOURCE, A2_HEADING_SCOPE, A2_HEADING_NEVER, A2_KEEP } from '../lib/a2-selector.mjs';
import { writeCheckRecord } from '../lib/check-record.mjs';

const NAME = 'a2_containment';

const DISCOVERY = 'never_to_be_pushed/discovery/scrape';
if (!existsSync(`${DISCOVERY}/raw`)) {
  console.log('check_a2_assets: no discovery capture — skipped');
  writeCheckRecord(NAME, { ran: false, count: 0, status: 'skipped', reason: 'no discovery capture' });
  process.exit(0);
}
const STAMP = readdirSync(`${DISCOVERY}/raw`).sort().reverse()[0];   // newest, not arbitrary
const PAGES = ['home', 'nfl', 'ncaaf', 'nba', 'wnba'];

// Both sides are compared as host + pathname + search. Seeded url_path values are
// absolute, while a captured currentSrc/src can be protocol-relative or resolved against
// the file:// document — so the scheme is dropped and each side is parsed as a URL.
const norm = (u, base) => { try { const x = new URL(u, base); return x.host + x.pathname + x.search; } catch { return u; } };
const seeded = new Map();   // page -> Set(normalized url)
for (const line of readFileSync('backend/seed/data/asset.jsonl', 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  if (!seeded.has(r.page_key)) seeded.set(r.page_key, new Set());
  seeded.get(r.page_key).add(norm((r.url_path || '') + (r.query ? '?' + r.query : ''), 'https://seed.invalid/'));
}

const b = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const p = await b.newPage();
let violations = 0, checkedPages = 0;

for (const page of PAGES) {
  const file = `${process.cwd()}/${DISCOVERY}/raw/${STAMP}/${page}/document.scrolled.html`;
  if (!existsSync(file)) continue;
  checkedPages++;
  await p.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  const excludedUrls = await p.evaluate(({ SEL, HEAD, HEAD_SCOPE, HEAD_NEVER }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const ex = new Set(document.querySelectorAll(SEL));
    const HEADRE = new RegExp(HEAD, 'i');
    document.querySelectorAll(HEAD_SCOPE).forEach(m => {
      if (m.closest(HEAD_NEVER)) return;   // a feed item's headline is data, not a module name
      const h = m.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      if (h && HEADRE.test(clean(h.innerText))) ex.add(m);
    });
    const inside = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (ex.has(e)) return true; return false; };
    // An asset is a violation only when it appears EXCLUSIVELY inside excluded modules.
    // The same URL legitimately appears in both places: /i/fantasy/ffl2025.png is used by
    // the public Fantasy nav pillar as well as by the excluded fantasy rail, and the nav
    // pillar is public chrome we deliberately keep.
    const norm = u => { try { const x = new URL(u, location.href); return x.host + x.pathname + x.search; } catch { return u; } };
    const excl = [], keep = [];
    document.querySelectorAll('img').forEach(i => {
      const attr = i.getAttribute('src') || '';
      const raw = attr.startsWith('//') ? 'https:' + attr : (i.currentSrc || i.src); if (!raw) return;
      const u = norm(raw);
      (inside(i) ? excl : keep).push(u);
    });
    const keepSet = new Set(keep);
    return [...new Set(excl)].filter(u => !keepSet.has(u));
  }, { SEL: A2_SELECTOR, HEAD: A2_HEADING_SOURCE, HEAD_SCOPE: A2_HEADING_SCOPE, HEAD_NEVER: A2_HEADING_NEVER });

  const seededHere = seeded.get(page) || new Set();
  const bad = excludedUrls.filter(u => seededHere.has(u) || seededHere.has(u.split('?')[0]));
  if (bad.length) {
    violations += bad.length;
    console.log(`  ${page}: ${bad.length} A2-excluded asset(s) present in the seed`);
    bad.slice(0, 5).forEach(u => console.log(`      ${u.slice(0, 96)}`));
  }
}
await b.close();

console.log(`check_a2_assets: ${checkedPages} page(s) checked against the captured DOM`);
if (violations) {
  writeCheckRecord(NAME, { ran: true, count: checkedPages, status: 'fail', reason: `${violations} excluded asset(s) seeded` });
  console.log(`\nFAIL: ${violations} seeded asset(s) come from an A2-excluded module`); process.exit(1);
}
if (checkedPages === 0) {
  // A check that examined nothing must not report a clean bill — that is exactly the
  // "negative verdict from a probe that could not have seen the answer" shape.
  writeCheckRecord(NAME, { ran: false, count: 0, status: 'skipped', reason: 'no captured documents' });
  console.log('SKIPPED: no captured documents found, nothing was checked');
  process.exit(0);
}
writeCheckRecord(NAME, { ran: true, count: checkedPages, status: 'pass' });
console.log('PASS: no seeded asset comes from an A2-excluded module');
