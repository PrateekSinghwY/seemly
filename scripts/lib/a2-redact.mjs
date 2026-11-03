// A2 redaction on a live page, from the single definition in a2-selector.mjs. The oracle
// hides excluded regions with `visibility:hidden`; a gate comparing the clone against it
// must hide the same regions, or every clone element inside them reads as a diff. Every
// tool that redacts (oracle, pixel-diff, page-complete) calls this, so the two sides
// cannot drift.
import { A2_SELECTOR, A2_HEADING_SOURCE, A2_HEADING_SCOPE, A2_HEADING_NEVER, A2_KEEP } from './a2-selector.mjs';

/** Hide every A2 region on `page`. Returns `{ count, regions }` in page CSS px. */
export async function redactA2(page) {
  // Everything the callback needs arrives as an argument: it runs in the page, where no
  // module-scope name exists.
  return page.evaluate(({ SEL, HEAD, HEAD_SCOPE, HEAD_NEVER, KEEP }) => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const SIGNAL = new RegExp(HEAD, 'i');
    const set = new Set(document.querySelectorAll(SEL));
    document.querySelectorAll(HEAD_SCOPE).forEach(m => {
      if (m.closest(HEAD_NEVER)) return;   // a feed item's headline is data, not a module name
      const h = m.querySelector('h1,h2,h3,[class*=Title],[class*=header],[class*=Header]');
      if (h && SIGNAL.test(clean(h.innerText))) set.add(m);
    });
    document.querySelectorAll(KEEP).forEach(e => set.delete(e));
    const els = [...set];
    els.forEach((e, i) => e.setAttribute('data-oracle-redact', String(i)));
    let st = document.getElementById('__oracle_redact');
    if (!st) { st = document.createElement('style'); st.id = '__oracle_redact'; document.head.appendChild(st); }
    st.textContent = '[data-oracle-redact]{visibility:hidden!important}';
    const regions = els.map(e => {
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    }).filter(r => r.w > 4 && r.h > 4);
    return { count: els.length, regions };
  }, { SEL: A2_SELECTOR, HEAD: A2_HEADING_SOURCE, HEAD_SCOPE: A2_HEADING_SCOPE, HEAD_NEVER: A2_HEADING_NEVER, KEEP: A2_KEEP });   // A2_KEEP is already a comma-joined selector string
}
