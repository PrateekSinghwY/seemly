// Personal-detail grep (ASSUMPTIONS A3). Exit 1 on any hit. Run after every page.
// Forbidden literals are matched by SHA-256 so this file never contains them.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join, basename } from 'path';
const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo

const ROOT = process.argv[2] || REPO + '/never_to_be_pushed/discovery';
const SELF = basename(new URL(import.meta.url).pathname);
const SKIP_FILES = new Set([SELF, 'forbidden.sha256', 'scrub-log.jsonl', 'package-lock.json', 'package.json']);
const sha = s => createHash('sha256').update(s).digest('hex');

const forbidden = new Set(
  existsSync(join(ROOT, 'tools/forbidden.sha256'))
    ? readFileSync(join(ROOT, 'tools/forbidden.sha256'), 'utf8').split('\n').map(s=>s.trim()).filter(Boolean)
    : []
);

let gitName = '', gitEmail = '';
try { gitName  = execFileSync('git', ['-C', REPO, 'config', 'user.name'],  {encoding:'utf8'}).trim(); } catch {}
try { gitEmail = execFileSync('git', ['-C', REPO, 'config', 'user.email'], {encoding:'utf8'}).trim(); } catch {}

const allowlist = new Set(
  existsSync(join(ROOT, 'tools/personal-allowlist.tsv'))
    ? readFileSync(join(ROOT, 'tools/personal-allowlist.tsv'), 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t')[0].trim())
    : []
);

const PATTERNS = [
  gitName  && { label:'git user.name',  re: new RegExp(gitName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi') },
  gitEmail && { label:'git user.email', re: new RegExp(gitEmail.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), 'gi') },
  { label:'email pattern', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?!png|jpe?g|gif|svg|webp|css|js|woff2?)[A-Za-z]{2,}\b/g },
  { label:'phone pattern', re: /(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}/g },
].filter(Boolean);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    // pw-profile holds browser session cookies by design; extensions are vendor code.
    // Both live under never_to_be_pushed/ and never reach the repo.
    if (e === 'node_modules' || e === '.git' || e === 'pw-profile' || e === 'extensions') continue;
    const p = join(d, e);
    let st; try { st = statSync(p); } catch { continue; }   // dangling symlinks
    if (st.isDirectory()) walk(p);
    else if (!SKIP_FILES.has(e) && /\.(md|json|jsonl|txt|mjs|js|html|csv)$/.test(e)) files.push(p);
  }
})(ROOT);

let hits = 0;
for (const f of files) {
  let txt; try { txt = readFileSync(f, 'utf8'); } catch { continue; }
  for (const { label, re } of PATTERNS) {
    const m = (txt.match(re) || []).filter(x => !allowlist.has(x.trim()));
    if (m.length) { console.log(`HIT [${label}] ${f}: ${[...new Set(m)].slice(0,3).join(', ')}`); hits++; }
  }
  if (forbidden.size) {
    for (const w of new Set(txt.split(/[^A-Za-z0-9']+/))) {
      if (w.length < 4) continue;
      if (forbidden.has(sha(w))) { console.log(`HIT [forbidden literal] ${f}`); hits++; break; }
    }
  }
}

console.log(`\nscanned ${files.length} files`);
if (hits) { console.log(`PERSONAL-DETAIL GREP: ${hits} hit(s) - RUN STOPS`); process.exit(1); }
console.log('PERSONAL-DETAIL GREP: 0 hits');
