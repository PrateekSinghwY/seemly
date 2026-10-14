import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LessonStore, tokens } from "../lessons.mjs";
import { areaOf, itemAreas, items, mine } from "../mine.mjs";
import { add, read, trend } from "../scorecard.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "seemly-learn-"));
const MODAL = "Every modal traps focus and restores it on close";

test("record: new lesson starts as a prose candidate with its origin", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  const { lesson, isNew } = s.record({ summary: MODAL, trigger: "correction", build: "espn-01", tags: { phase: "build", kind: "modal" } });
  assert.equal(isNew, true);
  assert.equal(lesson.level, "prose");
  assert.equal(lesson.status, "candidate");
  assert.deepEqual(lesson.tags, { phase: ["build"], kind: ["modal"] });
  assert.throws(() => s.record({ summary: "x y z", trigger: "correction" }), /build is required/);
});

test("dedupe: a reworded duplicate in the same phase is one lesson seen twice", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  s.record({ summary: MODAL, trigger: "correction", build: "b1", tags: { phase: "build" } });
  const r = s.record({ summary: "every modal must trap focus, and restore focus on close", trigger: "gate-catch", build: "b2", tags: { phase: "build" } });
  assert.equal(r.isNew, false);
  assert.equal(s.rows.length, 1);
  assert.equal(r.lesson.seen.length, 2);
  // Same words in a different phase are a different lesson.
  assert.equal(s.record({ summary: MODAL, trigger: "correction", build: "b2", tags: { phase: "capture" } }).isNew, true);
});

test("never weaken: a lowering correction is stored rejected and cannot be activated", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  const { lesson } = s.record({ summary: "skip the pixel gate on modals", trigger: "correction", build: "b1", weakens: true });
  assert.equal(lesson.status, "rejected");
  assert.throws(() => s.activate(lesson.id), /would weaken/);
});

test("promotion: seen in three distinct builds", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  for (const b of ["b1", "b1", "b2"]) s.record({ summary: MODAL, trigger: "correction", build: b });
  assert.equal(s.review().promote.length, 0);
  s.record({ summary: MODAL, trigger: "correction", build: "b3" });
  assert.equal(s.review().promote.length, 1);
});

test("ladder: recurrence after activation flags escalation; gate needs a check and an eval", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  const { lesson } = s.record({ summary: MODAL, trigger: "correction", build: "b1" });
  s.activate(lesson.id);
  assert.equal(s.record({ summary: MODAL, trigger: "verify-failure", build: "b1" }).recurred, false);
  assert.equal(s.record({ summary: MODAL, trigger: "verify-failure", build: "b2" }).recurred, true);
  assert.deepEqual(s.review().escalate.map((l) => l.id), [lesson.id]);
  s.escalate(lesson.id, { build: "b2" });
  assert.equal(lesson.level, "checklist");
  assert.equal(s.review().escalate.length, 0);
  assert.throws(() => s.escalate(lesson.id, { to: "gate", check: "scripts/gates/x.mjs" }), /eval case/);
  s.escalate(lesson.id, { to: "gate", check: "scripts/gates/x.mjs", evalId: "E23", build: "b2" });
  assert.equal(lesson.level, "gate");
});

test("select: only relevant, readable lessons, recurrences first", () => {
  const s = new LessonStore(join(tmp(), "l.jsonl"));
  const a = s.record({ summary: MODAL, trigger: "correction", build: "b1", tags: { phase: "build", kind: "modal" } }).lesson;
  const b = s.record({ summary: "Carousel arrows walked to both ends during capture", trigger: "correction", build: "b1", tags: { phase: "capture", kind: "carousel" } }).lesson;
  const c = s.record({ summary: "Dates render in UTC everywhere", trigger: "correction", build: "b1", tags: { phase: "build", kind: "any" } }).lesson;
  const g = s.record({ summary: "No literal domain strings in JSX", trigger: "gate-catch", build: "b1", tags: { phase: "build", kind: "any" } }).lesson;
  for (const l of [a, b, c, g]) s.activate(l.id);
  s.escalate(g.id, { to: "gate", check: "scripts/gates/check_jsx_literals.mjs", evalId: "E20" });
  s.record({ summary: "every date renders in UTC everywhere", trigger: "verify-failure", build: "b2", tags: { phase: "build" } });
  const picked = s.select({ phase: "build", kind: "modal" }).map((l) => l.id);
  assert.deepEqual(picked, [c.id, a.id]); // tie on tags; c recurred in b2, so it leads
  assert.equal(s.select({ phase: "build", kind: "table" })[0].id, c.id);
});

test("persistence and merge of a build inbox", () => {
  const dir = tmp();
  const shared = new LessonStore(join(dir, "shared.jsonl"));
  shared.record({ summary: MODAL, trigger: "correction", build: "b1" });
  shared.save();
  const inbox = new LessonStore(join(dir, "inbox.jsonl"));
  inbox.record({ summary: "Every modal traps focus, restores it on close", trigger: "gate-catch", build: "b2" });
  inbox.record({ summary: "Tooltips never on disabled controls", trigger: "correction", build: "b2" });
  inbox.save();
  const back = new LessonStore(join(dir, "shared.jsonl"));
  assert.deepEqual(back.merge(new LessonStore(join(dir, "inbox.jsonl"))), { added: 1, merged: 1 });
  assert.equal(back.rows.length, 2);
});

test("tokens normalise case, punctuation, stop words and plurals", () => {
  assert.deepEqual(tokens("The Modals, trapping FOCUS!"), ["modal", "trapp", "focu"]);
});

test("scorecard: trend flags a metric that got worse, not gate catches", () => {
  const f = join(tmp(), "s.jsonl");
  add(f, { build: "b1", metrics: { corrections: 10, gateCatches: 2 } });
  add(f, { build: "b2", metrics: { corrections: 6, gateCatches: 4 } });
  add(f, { build: "b3", metrics: { corrections: 12, gateCatches: 9 } });
  const t = Object.fromEntries(trend(read(f)).map((x) => [x.metric, x]));
  assert.equal(t.corrections.worse, true);
  assert.equal(t.gateCatches.worse, false);
  assert.throws(() => add(f, { build: "b4", metrics: { vibes: 1 } }), /unknown metric/);
});

test("miner: splits numbered bold items, stops at visual proof, tags areas", () => {
  const body = "## Summary\n\nTwo fixes.\n\n**1. Left column from 1260px.** The grid hid it below 1280.\n\n**2. LM pages gated.** Fans saw forms.\n\n## Visual proof\n\n**3. not a fix** screenshot";
  assert.deepEqual(items("fix: x (#41)", body), ["Left column from 1260px. The grid hid it below 1280.", "LM pages gated. Fans saw forms."]);
  assert.deepEqual(items("fix: bullets", "- one thing\n- another that\nwraps here\n\nprose\n## Test\n- not this"), ["one thing", "another that wraps here"]);
  const paths = ["frontend/components/LmTools/parts.tsx", "frontend/components/PageGrid/PageGrid.tsx", "docs/domain/app-shell.md"];
  assert.deepEqual(itemAreas("PageGrid switches at 1260", paths, ["ui:LmTools", "ui:PageGrid", "docs"]), ["ui:PageGrid"]);
  assert.deepEqual(itemAreas("nothing named", paths, ["ui:LmTools", "docs"]), ["ui:LmTools", "docs"]);
  assert.deepEqual(items("fix(api): return 404 for a missing ticket (#9)", ""), ["return 404 for a missing ticket"]);
  assert.equal(areaOf("frontend/components/PageGrid/PageGrid.tsx"), "ui:PageGrid");
  assert.equal(areaOf("backend/seed/data/ui_copy.jsonl"), "seed");
});

test("miner: reads fix commits from a real git repo", () => {
  const repo = tmp();
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("commit", "-qm", "feat: start");
  writeFileSync(join(repo, "a.txt"), "2");
  git("commit", "-qam", "fix: date rendered in local zone\n\n- dates now render in UTC");
  const found = mine(repo, { build: "demo" });
  assert.equal(found.length, 1);
  assert.equal(found[0].summary, "dates now render in UTC");
  assert.equal(found[0].trigger, "post-build-fix");
});
