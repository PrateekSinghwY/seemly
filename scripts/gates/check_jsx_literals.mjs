// JSX literal gate, AST-based (ESPN_SCRAPE Part 6.2).
//
// Replaces a regex that only matched single-line `>text<`. Because `[^<>{}\n]` forbids
// a newline, every Prettier-wrapped JSX text child — the normal formatting in this repo
// — was invisible to it, so the gate did not provide the guarantee the app description
// claims. Parsing the real syntax tree is the only way to see them all.
//
// Fails on:
//   * JSX text children that contain a letter
//   * template literals with no substitutions used as JSX children
//   * string literals passed to title / alt / aria-label / placeholder
//
// Allowed: any expression that reads a prop, a fetched field, or a variable — the clone
// renders text it fetched.
// Resolve the compiler from frontend/, deliberately. typescript ships CJS (so the ESM
// default import exposes nothing), and the repo root would otherwise pull TypeScript 7,
// the native port, whose entry point does not expose the classic compiler API at all.
// The frontend's 5.x is the version that actually type-checks this code.
import { createRequire } from "module";
const require_ = createRequire(import.meta.url);
const ts = require_(require_.resolve("typescript", { paths: [new URL("../frontend", import.meta.url).pathname] }));
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const SCAN = ["frontend/app", "frontend/components", "frontend/lib"];
const SKIP = new Set(["node_modules", ".next", "dist", "build"]);
const STRING_PROPS = new Set(["title", "alt", "aria-label", "placeholder"]);

const ALLOWLIST = new Set(
  existsSync(join(ROOT, "scripts/no_literals_allowlist.txt"))
    ? readFileSync(join(ROOT, "scripts/no_literals_allowlist.txt"), "utf8")
        .split("\n").filter(l => l.trim() && !l.startsWith("#"))
        .map(l => l.split("\t")[0].trim().toLowerCase())
    : []
);

function files(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx|jsx)$/.test(e)) out.push(p);
  }
  return out;
}

const hits = [];
const scanned = SCAN.flatMap(d => files(join(ROOT, d)));

for (const file of scanned) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = node => src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
  const report = (node, what, value) => {
    const v = value.trim();
    if (!v || ALLOWLIST.has(v.toLowerCase())) return;
    hits.push(`${relative(ROOT, file)}:${at(node)}  ${what}: ${JSON.stringify(v.slice(0, 60))}`);
  };

  const walk = node => {
    // JSX text child, however it is wrapped across lines
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]/.test(text)) report(node, "JSX text literal", text);
    }
    // `{`some text`}` as a child — a template with no substitutions is a literal
    if (ts.isJsxExpression(node) && node.expression &&
        ts.isNoSubstitutionTemplateLiteral(node.expression) &&
        /[A-Za-z]/.test(node.expression.text)) {
      report(node, "template literal child", node.expression.text);
    }
    // user-visible string props
    if (ts.isJsxAttribute(node) && node.name && STRING_PROPS.has(node.name.getText(src))) {
      const init = node.initializer;
      let value = null;
      if (init && ts.isStringLiteral(init)) value = init.text;
      else if (init && ts.isJsxExpression(init) && init.expression) {
        if (ts.isStringLiteral(init.expression)) value = init.expression.text;
        else if (ts.isNoSubstitutionTemplateLiteral(init.expression)) value = init.expression.text;
      }
      if (value && /[A-Za-z]/.test(value)) report(node, `literal ${node.name.getText(src)}`, value);
    }
    ts.forEachChild(node, walk);
  };
  walk(src);
}

console.log(`check_jsx_literals: ${scanned.length} .tsx/.jsx file(s) parsed (AST, not regex)`);
for (const h of hits.slice(0, 40)) console.log(`    ${h}`);
if (hits.length) { console.log(`\nFAIL: ${hits.length} JSX literal(s)`); process.exit(1); }
console.log("PASS: no JSX literals");
