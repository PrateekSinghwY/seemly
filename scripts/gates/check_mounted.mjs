// MOUNTED gate.
//
// A component that nothing imports is dead code, however finished it looks. The
// fresh-eyes review found four components marked `built` and one committed as "build
// the scores strip" while `page.tsx` returned null — so no visual, a11y or pixel pass
// could have run against any of them, and every gate still passed.
//
// Every component REGISTRY.md marks **built** must be imported by the shell layout or
// by a page component.
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";
import { writeCheckRecord } from "../lib/check-record.mjs";

const NAME = "components_mounted";

const ROOT = process.cwd();
const REGISTRY = join(ROOT, "frontend/components/modules/REGISTRY.md");
if (!existsSync(REGISTRY)) {
  writeCheckRecord(NAME, { ran: false, count: 0, status: "skipped", reason: "no REGISTRY.md" });
  console.log("check_mounted: no REGISTRY.md — skipped"); process.exit(0);
}

// rows look like: | `GlobalNav` | ... | **built** |
const built = [];
for (const line of readFileSync(REGISTRY, "utf8").split("\n")) {
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").map(c => c.trim());
  const name = (cells[1] || "").replace(/[`*]/g, "").trim();
  const status = (cells[cells.length - 2] || "").replace(/\*/g, "").trim().toLowerCase();
  if (name && status === "built") built.push(name);
}

// every import site outside the component's own folder
const sources = [];
(function walk(d) {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d)) {
    if (["node_modules", ".next", "dist"].includes(e)) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx|ts|jsx|js)$/.test(e)) sources.push(p);
  }
})(join(ROOT, "frontend"));

const unmounted = [];
for (const name of built) {
  const mounted = sources.some(f => {
    if (f.includes(`/components/${name}/`)) return false;         // its own folder
    if (f.endsWith("REGISTRY.md")) return false;
    const txt = readFileSync(f, "utf8");
    // Only a real import counts: the name inside a static import clause, or a dynamic
    // import() whose target path names the component. A mention in a comment, string or
    // JSX prop in a file that merely imports something else is not a mount.
    const staticImport = new RegExp(`\\bimport\\s+(?:type\\s+)?[^;'"]*?\\b${name}\\b[^;'"]*?\\sfrom\\s*["'][^"']+["']`);
    const dynamicImport = new RegExp(`\\bimport\\(\\s*["'][^"']*\\b${name}\\b[^"']*["']\\s*\\)`);
    return staticImport.test(txt) || dynamicImport.test(txt);
  });
  if (!mounted) unmounted.push(name);
}

console.log(`check_mounted: ${built.length} component(s) marked built in REGISTRY.md`);
if (unmounted.length) {
  writeCheckRecord(NAME, { ran: true, count: built.length, status: "fail", reason: `${unmounted.length} unmounted` });
  console.log(`\nFAIL: ${unmounted.length} marked built but imported nowhere:`);
  unmounted.forEach(n => console.log(`    ${n}`));
  process.exit(1);
}
if (built.length === 0) {
  writeCheckRecord(NAME, { ran: false, count: 0, status: "skipped", reason: "nothing marked built" });
  console.log("SKIPPED: nothing marked built yet"); process.exit(0);
}
writeCheckRecord(NAME, { ran: true, count: built.length, status: "pass" });
console.log("PASS: every built component is mounted");
