// Golden click traces, replayed on the clone (needs a running app).
//
// A trace file (default `scripts/traces/*.json`) is the reference walk's record: per route, every
// control and what it did on the reference. On the clone each step must hold under the repo's
// link rules:
//   link         the control exists and goes to that path (a served page), or a slugged form
//                under it, or is redirected inside the clone, or renders disabled (ruled out);
//   state        activating it changes the page in place;
//   no-external  no enabled control with that label leaves the app.
// A step carrying `waived` is reported, not run: its reason names the ruling.
//
// Traces carry no personal or public-figure names (the external names check reads them):
//   `label`     the control's visible text prefix, for UI copy (tabs, buttons, headings);
//   `includes`  a name-free fragment, for a headline that opens with a name;
//   `href`      an id path prefix (`/player/_/id/123`), for a link to a person or entity. Where the
//               clone renders that entity disabled (no href), the runner resolves the display name
//               at run time from the JSON the page itself fetched: any object with that `id` and a
//               `displayName` / `shortName` / `name`, so the name comes from the DB, not the repo.
// Usage: node check_traces.mjs [baseUrl] [trace.json ...]   (default http://localhost:3000)
import { chromium } from 'playwright';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { writeCheckRecord } from '../lib/check-record.mjs';

const BASE = process.argv[2] || 'http://localhost:3000';
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : readdirSync('scripts/traces').filter((f) => f.endsWith('.json')).map((f) => `scripts/traces/${f}`);
const traces = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).traces);
mkdirSync('never_to_be_pushed/discovery/pixel-reports', { recursive: true });
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const names = new Map();
const collect = (o) => {
  if (!o || typeof o !== 'object') return;
  const id = o.id != null ? String(o.id) : null;
  if (id && /^\d+$/.test(id)) {
    const aka = [o.displayName, o.shortName, o.name].filter((x) => typeof x === 'string');
    if (aka.length) names.set(id, [...new Set([...(names.get(id) || []), ...aka])]);
  }
  for (const v of Object.values(o)) collect(v);
};
page.on('response', async (r) => { if ((r.headers()['content-type'] || '').includes('json')) collect(await r.json().catch(() => null)); });

const results = [];
let failed = 0;
for (const { route, steps } of traces) {
  names.clear();
  await page.goto(BASE + route, { waitUntil: 'load', timeout: 120000 });
  await page.waitForTimeout(3000);
  for (const step of steps) {
    const tag = step.label ?? step.href ?? step.includes;
    if (step.waived) { results.push({ route, label: tag, expect: step.expect, to: step.to, ok: true, got: `waived: ${step.waived}` }); continue; }
    const aka = step.href ? names.get(step.href.split('/').pop()) ?? [] : [];
    const found = await page.evaluate(({ label, href, includes, aka }) => {
      const n = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const texts = (x) => [x.innerText, x.getAttribute('aria-label'), x.querySelector('img')?.alt];
      // The page body first: a short label also names a global nav link.
      const pick = (root) => [...root.querySelectorAll('a, button, [role=tab], [role=button], [aria-disabled]')].find((x) => href
        ? (x.getAttribute('href') || '').startsWith(href)
        : texts(x).some((t) => (includes ? n(t).includes(includes) : n(t).startsWith(label))));
      const byName = (root) => aka.length > 0 && [...root.querySelectorAll('[aria-disabled=true]')]
        .find((x) => texts(x).some((t) => aka.some((a) => n(t).replace(/^\d+ /, '').startsWith(a))));
      const main = document.querySelector('main') ?? document;
      const e = pick(main) ?? pick(document) ?? (href ? byName(main) : null);
      if (!e) return null;
      e.setAttribute('data-trace', '1');
      return { tag: e.tagName, href: e.getAttribute('href'), disabled: e.hasAttribute('disabled') || e.getAttribute('aria-disabled') === 'true' };
    }, { label: norm(step.label).slice(0, 60), href: step.href ?? null, includes: step.includes ?? null, aka });
    let ok = false;
    let got = '';
    if (step.expect === 'no-external') {
      ok = !found || found.disabled || !/^https?:/.test(found.href || '');
      got = found ? `${found.tag} ${found.href ?? ''}` : 'absent';
    } else if (!found) {
      got = 'no control found';
    } else if (step.expect === 'link') {
      const path = (step.to || '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
      const href = (found.href || '').replace(/[?#].*$/, '');
      ok = found.disabled || href === path || href.startsWith(`${path}/`) || /^\/([a-z0-9-]+\/?)?$/.test(href);
      got = found.disabled ? 'disabled' : href;
    } else if (step.expect === 'state') {
      const snap = () => page.evaluate(() => { const h = document.querySelector('main')?.innerHTML ?? ''; let x = 0; for (let i = 0; i < h.length; i++) x = (x * 31 + h.charCodeAt(i)) | 0; return `${h.length}:${x}`; });
      const before = await snap();
      // Activate it directly: a pointer click can land on sticky chrome above it.
      await page.locator('[data-trace]').first().evaluate((e) => e.click()).catch(() => {});
      await page.waitForTimeout(600);
      const after = await snap();
      ok = before !== after || found.disabled;
      got = `${before} -> ${after}`;
      await page.keyboard.press('Escape').catch(() => {});
    }
    await page.evaluate(() => document.querySelector('[data-trace]')?.removeAttribute('data-trace'));
    if (!ok) failed++;
    results.push({ route, label: tag, expect: step.expect, to: step.to, ok, got });
  }
}
await browser.close();
writeFileSync('never_to_be_pushed/discovery/pixel-reports/_traces.json', JSON.stringify({ ran: true, at: new Date().toISOString(), steps: results.length, failed, results }, null, 1));
for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL ${r.route}  [${r.expect}] "${String(r.label).slice(0, 50)}"  got: ${r.got}${r.to ? `  want: ${r.to}` : ''}`);
console.log(`check_traces: ${results.length} step(s) on ${traces.length} route(s), ${failed} failed`);
writeCheckRecord('golden_traces', { ran: results.length > 0, count: results.length, status: results.length ? (failed ? 'fail' : 'pass') : 'skipped', reason: results.length ? null : 'no trace steps' });
process.exit(failed ? 1 : 0);
