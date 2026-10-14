// RL_BUILD step 8: per-property computed-style diff for the shell, reference vs clone.
// Both sides run under the same determinism lock through the SAME persistent profile
// over CDP, so a difference is the build's, not the browser's.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const MANIFEST = `width height minWidth minHeight maxWidth maxHeight boxSizing
paddingTop paddingRight paddingBottom paddingLeft marginTop marginRight marginBottom marginLeft
borderTopWidth borderTopStyle borderTopColor borderBottomWidth borderBottomStyle borderBottomColor
borderTopLeftRadius borderTopRightRadius borderBottomRightRadius borderBottomLeftRadius
display position top right bottom left zIndex float clear
flexDirection flexWrap flexGrow flexShrink flexBasis order
justifyContent alignItems alignSelf alignContent gap rowGap columnGap
overflow overflowX overflowY
fontFamily fontSize fontWeight fontStyle lineHeight letterSpacing wordSpacing
textTransform textAlign textIndent textDecorationLine whiteSpace verticalAlign
color backgroundColor backgroundImage backgroundSize backgroundPosition backgroundRepeat
opacity boxShadow outlineWidth outlineStyle outlineColor outlineOffset
cursor pointerEvents userSelect`.split(/\s+/).filter(Boolean);

// The shell elements this slice built, addressed on BOTH sides.
const TARGETS = [
  ['nav-bar',      { ref: '#global-nav',                 clone: 'nav' }],
  ['logo-anchor',  { ref: '.logo-header a',              clone: 'nav .espn-logo' }],
  ['pillar-first', { ref: '#global-nav li.sports a',     clone: 'nav ul li a' }],
  ['tools-search', { ref: 'ul.tools li.search a',        clone: 'nav .espn-icon-search' }],
];

const REF_FILE = process.argv[2];
const CLONE_URL = process.argv[3] || 'http://localhost:3000/';
const OUT = 'never_to_be_pushed/discovery/captures/ref/shell';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

async function grab(url, side) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(1500);

  const out = await page.evaluate(({ MANIFEST, TARGETS, side }) => {
    const res = {};
    for (const [name, sel] of TARGETS) {
      const el = document.querySelector(sel[side]);
      if (!el) { res[name] = { missing: true, selector: sel[side] }; continue; }
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const props = {};
      for (const p of MANIFEST) props[p] = cs[p];
      res[name] = { selector: sel[side], box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], props };
    }
    return res;
  }, { MANIFEST, TARGETS, side });

  // fonts actually rendered (CSS.getPlatformFontsForNode)
  const fonts = {};
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  for (const [name, sel] of TARGETS) {
    try {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel[side] });
      if (!nodeId) continue;
      const pf = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }).catch(() => null);
      if (pf) fonts[name] = pf.fonts.map(f => `${f.familyName} x${f.glyphCount}`);
    } catch { /* not present on this side */ }
  }

  const ax = await cdp.send('Accessibility.getFullAXTree').catch(() => null);
  const headerAx = ax ? ax.nodes.filter(n => ['navigation', 'banner', 'link', 'button'].includes(n.role?.value))
    .slice(0, 40).map(n => `${n.role.value}: ${n.name?.value ?? ''}`.trim()) : [];

  await page.close();
  return { styles: out, fonts, ax: headerAx };
}

console.log('capturing reference…');
const ref = await grab(REF_FILE, 'ref');
writeFileSync(`${OUT}/reference.json`, JSON.stringify(ref, null, 2));

console.log('capturing clone…');
const clone = await grab(CLONE_URL, 'clone');
writeFileSync(`${OUT}/clone.json`, JSON.stringify(clone, null, 2));

// ---- per-property diff ----
const rows = [];
for (const [name] of TARGETS) {
  const a = ref.styles[name], b = clone.styles[name];
  if (!a || a.missing) { rows.push({ element: name, property: '(element)', expected: 'present', got: 'MISSING IN REFERENCE' }); continue; }
  if (!b || b.missing) { rows.push({ element: name, property: '(element)', expected: 'present', got: 'MISSING IN CLONE' }); continue; }
  for (const k of ['x', 'y', 'w', 'h'].map((k, i) => [k, i])) {
    if (a.box[k[1]] !== b.box[k[1]]) rows.push({ element: name, property: `box.${k[0]}`, expected: a.box[k[1]], got: b.box[k[1]] });
  }
  for (const p of MANIFEST) {
    if (a.props[p] !== b.props[p]) rows.push({ element: name, property: p, expected: a.props[p], got: b.props[p] });
  }
}
writeFileSync(`${OUT}/diff.json`, JSON.stringify(rows, null, 2));

console.log(`\nSTEP 8 PER-PROPERTY DIFF — ${rows.length} properties differ\n`);
const byEl = {};
rows.forEach(r => (byEl[r.element] = byEl[r.element] || []).push(r));
for (const [el, list] of Object.entries(byEl)) {
  console.log(`  ${el}  (${list.length})`);
  list.slice(0, 14).forEach(r => console.log(`     ${r.property.padEnd(22)} expected ${String(r.expected).slice(0,34).padEnd(36)} got ${String(r.got).slice(0,34)}`));
  if (list.length > 14) console.log(`     … ${list.length - 14} more`);
}
console.log('\nfonts (reference):', JSON.stringify(ref.fonts));
console.log('fonts (clone)    :', JSON.stringify(clone.fonts));
await browser.close();
