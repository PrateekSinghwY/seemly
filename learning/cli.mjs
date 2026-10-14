#!/usr/bin/env node
// seemly learning CLI. Paths default to this skill's tracked files.
//
//   node learning/cli.mjs record   --summary "..." --trigger correction --build B [--phase build --kind modal --area ui:Draft --tool chrome] [--evidence ".."] [--weakens]
//   node learning/cli.mjs select   [--phase build --kind modal --area ... --tool ...] [--limit 20]
//   node learning/cli.mjs activate --id L-xxxx
//   node learning/cli.mjs escalate --id L-xxxx [--to gate] [--check scripts/gates/x.mjs] [--eval E23] [--build B]
//   node learning/cli.mjs retire   --id L-xxxx --reason "..."
//   node learning/cli.mjs review   [--builds b1,b2,...]
//   node learning/cli.mjs merge    --from <inbox lessons.jsonl>
//   node learning/cli.mjs mine     --repo <path> [--range a..b] [--since 2026-10-01] [--build B] [--record]
//   node learning/cli.mjs evals
//   node learning/cli.mjs score add --build B --corrections 4 --postBuildFixes 12 ...
//   node learning/cli.mjs score trend
//   (any command) --store <lessons.jsonl>  --scorecard <scorecard.jsonl>

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { run as runEvals } from "./evals.mjs";
import { LessonStore } from "./lessons.mjs";
import { mine } from "./mine.mjs";
import { METRICS, add, read, trend } from "./scorecard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = dirname(here);
const argv = process.argv.slice(2);
const cmd = argv[0];
const sub = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
const metricOpts = Object.fromEntries(Object.keys(METRICS).map((k) => [k, { type: "string" }]));
const { values: o } = parseArgs({
  args: argv.slice(sub ? 2 : 1),
  options: {
    store: { type: "string", default: join(here, "lessons.jsonl") },
    scorecard: { type: "string", default: join(here, "scorecard.jsonl") },
    summary: { type: "string" }, trigger: { type: "string" }, build: { type: "string" }, evidence: { type: "string" },
    phase: { type: "string" }, kind: { type: "string" }, area: { type: "string" }, tool: { type: "string" },
    weakens: { type: "boolean" }, limit: { type: "string" }, id: { type: "string" }, to: { type: "string" },
    check: { type: "string" }, eval: { type: "string" }, reason: { type: "string" }, builds: { type: "string" },
    from: { type: "string" }, repo: { type: "string" }, range: { type: "string" }, since: { type: "string" },
    record: { type: "boolean" },
    ...metricOpts,
  },
});

const store = () => new LessonStore(o.store);
const brief = (l) => `${l.id}  [${l.status}/${l.level}] seen ${new Set(l.seen.map((s) => s.build)).size} build(s)  ${l.summary}`;
const ctx = () => ({ phase: o.phase, kind: o.kind, area: o.area, tool: o.tool });
const tags = () => Object.fromEntries(Object.entries(ctx()).filter(([, v]) => v).map(([k, v]) => [k, v.split(",")]));

switch (cmd) {
  case "record": {
    const s = store();
    const r = s.record({ summary: o.summary, trigger: o.trigger, build: o.build, evidence: o.evidence, tags: tags(), weakens: o.weakens });
    s.save();
    console.log(`${r.isNew ? "new" : "seen again"}${r.recurred ? " (RECURRED at " + r.lesson.level + ": escalate)" : ""}: ${brief(r.lesson)}`);
    break;
  }
  case "select":
    for (const l of store().select(ctx(), Number(o.limit ?? 20))) console.log(brief(l));
    break;
  case "activate": {
    const s = store();
    console.log(brief(s.activate(o.id)));
    s.save();
    break;
  }
  case "escalate": {
    const s = store();
    console.log(brief(s.escalate(o.id, { to: o.to, check: o.check, evalId: o.eval, build: o.build })));
    s.save();
    break;
  }
  case "retire": {
    const s = store();
    console.log(brief(s.retire(o.id, o.reason ?? "")));
    s.save();
    break;
  }
  case "review": {
    const r = store().review(o.builds ? o.builds.split(",") : []);
    for (const [k, list] of Object.entries(r)) {
      console.log(`== ${k} (${list.length})`);
      for (const l of list) console.log("  " + brief(l));
    }
    break;
  }
  case "merge": {
    const s = store();
    const res = s.merge(new LessonStore(o.from));
    s.save();
    console.log(`added ${res.added}, merged ${res.merged}`);
    break;
  }
  case "mine": {
    const found = mine(o.repo, { range: o.range, since: o.since, build: o.build });
    if (o.record) {
      const s = store();
      let added = 0;
      for (const c of found) if (s.record(c).isNew) added++;
      s.save();
      console.log(`${found.length} fix items, ${added} new candidate lessons -> ${o.store}`);
    } else {
      for (const c of found) console.log(JSON.stringify(c));
    }
    break;
  }
  case "evals": {
    const r = runEvals(skillRoot);
    for (const row of r.rows) {
      const seen = row.seenFailing === null ? "" : row.seenFailing ? "  (seen failing on bad fixture)" : "  BAD FIXTURE PASSED: check is not wired";
      console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id}  ${row.title ?? ""}${seen}`);
      if (row.out) console.log("      " + row.out.replace(/\n/g, "\n      "));
    }
    console.log(`manual (not yet executable): ${r.manual.length ? r.manual.join(" ") : "none"}`);
    process.exit(r.pass ? 0 : 1);
    break;
  }
  case "score": {
    if (sub === "add") {
      const metrics = Object.fromEntries(Object.keys(METRICS).filter((k) => o[k] !== undefined).map((k) => [k, Number(o[k])]));
      console.log(JSON.stringify(add(o.scorecard, { build: o.build, metrics })));
    } else {
      const t = trend(read(o.scorecard));
      if (!t.length) console.log("need at least two builds");
      for (const x of t) console.log(`${x.worse ? "WORSE" : "ok   "}  ${x.metric.padEnd(20)} latest ${x.latest}  earlier mean ${x.mean ?? "-"}`);
    }
    break;
  }
  default:
    console.error("commands: record select activate escalate retire review merge mine evals score");
    process.exit(2);
}
