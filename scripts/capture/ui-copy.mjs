// ui_copy is every rendered string that is NOT domain content: nav labels, module
// titles, button/legal/chrome copy. Source: provenance.jsonl kind=ui_copy.
import { readFileSync, writeFileSync } from 'fs';

const rows = readFileSync('scrape/provenance.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse);
const PERSONAL = /favorit|fantasy|for you|my teams|welcome /i;

const out = new Map();
for (const r of rows) {
  if (r.kind !== 'ui_copy') continue;
  const t = r.text.trim();
  if (!t || t.length > 120) continue;
  if (PERSONAL.test(t)) continue;                       // A2
  // a string that is the same on every page is global chrome; otherwise page-scoped
  const key = t.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0, 48);
  if (!key) continue;
  const id = `${r.module}|${key}`;
  if (!out.has(id)) out.set(id, { key, module: r.module, text: t, pages: new Set() });
  out.get(id).pages.add(r.page);
}

const final = [...out.values()].map(v => ({
  key: v.key, module: v.module, text: v.text,
  page: v.pages.size === 5 ? '*' : [...v.pages].join(','),
  _provenance: 'provenance.jsonl:ui_copy',
}));

writeFileSync('scrape/normalized/ui_copy.jsonl', final.map(r => JSON.stringify(r)).join('\n') + '\n');
const global = final.filter(r => r.page === '*').length;
console.log(`ui_copy rows: ${final.length}  (global '*': ${global}, page-scoped: ${final.length - global})`);
console.log('modules:', [...new Set(final.map(r => r.module))].join(', '));
