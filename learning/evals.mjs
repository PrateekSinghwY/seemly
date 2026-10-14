// The skill's regression suite. evals/cases.md lists every failure seemly has produced; this
// runs the ones that have been made executable (evals/runnable.jsonl) and reports the rest
// as manual, so "every case still passes" is a command instead of a promise.
//
// A runnable case: { id, cmd: [argv...], cwd?, expectExit: 0, bad?: { cmd, expectExit: != 0 } }
// `bad` is the same check pointed at a fixture that contains the defect: it must FAIL there,
// or the check was never seen failing and does not count (distill.md, Step 3 "Test").

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function manualIds(casesMd) {
  if (!existsSync(casesMd)) return [];
  return [...readFileSync(casesMd, "utf8").matchAll(/^\|\s*(E\d+)\s/gm)].map((m) => m[1]);
}

export function runnable(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function exec(spec, root) {
  const [bin, ...args] = spec.cmd;
  const r = spawnSync(bin, args, { cwd: spec.cwd ? join(root, spec.cwd) : root, encoding: "utf8", timeout: spec.timeoutMs ?? 120000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-5).join("\n") };
}

/** Run every runnable case from the skill root. Returns rows and an overall pass flag. */
export function run(skillRoot) {
  const cases = runnable(join(skillRoot, "evals", "runnable.jsonl"));
  const rows = cases.map((c) => {
    const good = exec(c, skillRoot);
    const okGood = good.code === (c.expectExit ?? 0);
    let okBad = null;
    let badOut = "";
    if (c.bad) {
      const bad = exec(c.bad, skillRoot);
      okBad = c.bad.expectExit === undefined ? bad.code !== 0 : bad.code === c.bad.expectExit;
      badOut = bad.out;
    }
    return { id: c.id, title: c.title, pass: okGood && okBad !== false, good: okGood, seenFailing: okBad, out: okGood ? "" : good.out, badOut: okBad === false ? badOut : "" };
  });
  const automated = new Set(cases.flatMap((c) => c.covers ?? [c.id]));
  const manual = manualIds(join(skillRoot, "evals", "cases.md")).filter((id) => !automated.has(id));
  return { rows, manual, pass: rows.every((r) => r.pass) };
}
