import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { latestStamp } from '../lib/snapshot.mjs';

const ROOT  = 'scrape';
const STAMP = latestStamp(ROOT);
const BASE  = `${ROOT}/raw/${STAMP}`;
const PAGES = ['home','nfl','ncaaf','nba','wnba'];

const norm = s => s.replace(/\s+/g,' ').trim();
// decode the entities the serializer introduced, so DOM text matches HTML source
const ENT = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'\u2026',
              rsquo:'\u2019', lsquo:'\u2018', ldquo:'\u201c', rdquo:'\u201d', mdash:'\u2014', ndash:'\u2013' };
const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const rows = [];
const counts = { exact: 0, formatted: 0, ui_copy: 0, unresolved: 0 };
let skippedNonText = 0;
const TS = /^(\d+[smhd]|\d{1,2}:\d{2}|Final.*|LIVE|Today|Yesterday)$/i;

for (const p of PAGES) {
  const dir = `${BASE}/${p}`;
  const htmlRaw = readFileSync(`${dir}/document.scrolled.html`, 'utf8');
  const html = norm(decode(htmlRaw));
  // concatenate every xhr body + global for this page
  let payload = '';
  for (const f of readdirSync(`${dir}/xhr`)) if (f.endsWith('.json') && !f.endsWith('.meta.json'))
    payload += readFileSync(`${dir}/xhr/${f}`, 'utf8');
  if (existsSync(`${dir}/globals`)) for (const f of readdirSync(`${dir}/globals`))
    payload += readFileSync(`${dir}/globals/${f}`, 'utf8');

  const payloadDecoded = norm(decode(payload));
  const nodes = readFileSync(`${dir}/text-nodes.jsonl`, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  for (const n of nodes) {
    const t = norm(n.text);
    if (!t) continue;
    // script/style bodies are not user-visible text; they are not provenance subjects
    if (/(^|>)(script|style|noscript|template)(\.|#|>|$)/i.test(n.path)) { skippedNonText++; continue; }
    if (/^(var |function |\(function|window\.|jQuery|if \(typeof|espn\.|\/\*|!function)/.test(t)) { skippedNonText++; continue; }
    let kind, src;
    if (payloadDecoded.includes(t) && t.length > 2) { kind = 'exact'; src = 'xhr|global'; }
    else if (TS.test(t))                     { kind = 'formatted'; src = 'client-format(from timestamp)'; }
    else if (html.includes(t))               { kind = 'ui_copy'; src = 'html:' + n.path.slice(0, 60); }
    else                                     { kind = 'UNRESOLVED'; src = '-'; }
    counts[kind === 'UNRESOLVED' ? 'unresolved' : kind]++;
    rows.push({ page: p, module: n.module, text: t.slice(0, 90), kind, src });
  }
}

const total = rows.length;
const md = [];
md.push('# provenance.md (SCRAPE Part 4)\n');
md.push(`_T0 snapshot \`${STAMP}\` · every visible text node on all five pages · source of truth is the hydrated DOM (ASSUMPTIONS A8)_\n`);
md.push('```');
md.push(`PROVENANCE   ${total} text nodes across 5 pages`);
md.push(`             ${counts.exact} exact   ${counts.formatted} formatted   ${counts.ui_copy} ui_copy   ${counts.unresolved} UNRESOLVED (must be 0)`);
md.push(`             ${skippedNonText} script/style nodes excluded (not user-visible text)`);
md.push('```\n');
md.push('| page | nodes | exact | formatted | ui_copy | UNRESOLVED |');
md.push('|---|---|---|---|---|---|');
for (const p of PAGES) {
  const r = rows.filter(x => x.page === p);
  md.push(`| ${p} | ${r.length} | ${r.filter(x=>x.kind==='exact').length} | ${r.filter(x=>x.kind==='formatted').length} | ${r.filter(x=>x.kind==='ui_copy').length} | ${r.filter(x=>x.kind==='UNRESOLVED').length} |`);
}
md.push('\n## By module\n');
const mods = [...new Set(rows.map(r => r.module))];
md.push('| module | nodes | exact | formatted | ui_copy | UNRESOLVED |');
md.push('|---|---|---|---|---|---|');
for (const m of mods.sort()) {
  const r = rows.filter(x => x.module === m);
  md.push(`| \`${m}\` | ${r.length} | ${r.filter(x=>x.kind==='exact').length} | ${r.filter(x=>x.kind==='formatted').length} | ${r.filter(x=>x.kind==='ui_copy').length} | ${r.filter(x=>x.kind==='UNRESOLVED').length} |`);
}
writeFileSync(`${ROOT}/provenance.md`, md.join('\n') + '\n');
writeFileSync(`${ROOT}/provenance.jsonl`, rows.map(r => JSON.stringify(r)).join('\n'));

console.log(`PROVENANCE   ${total} text nodes across 5 pages`);
console.log(`             ${counts.exact} exact   ${counts.formatted} formatted   ${counts.ui_copy} ui_copy   ${counts.unresolved} UNRESOLVED`);
console.log(`             ${skippedNonText} script/style nodes excluded`);
if (counts.unresolved) {
  console.log('\nfirst unresolved rows:');
  rows.filter(r => r.kind === 'UNRESOLVED').slice(0, 10).forEach(r => console.log(`  [${r.page}/${r.module}] ${r.text.slice(0,70)}`));
}
