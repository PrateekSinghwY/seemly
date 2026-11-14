import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { open } from "../store.mjs";
import { readNew } from "../watch.mjs";

test("watch: readNew returns only complete lines and resumes from its offset", () => {
  const f = join(mkdtempSync(join(tmpdir(), "watch-")), "events.jsonl");
  writeFileSync(f, '{"a":1}\n{"b":2}\n{"c":');
  const r1 = readNew(f, 0);
  assert.deepEqual(r1.lines, ['{"a":1}', '{"b":2}']);
  appendFileSync(f, '3}\n');
  const r2 = readNew(f, r1.offset);
  assert.deepEqual(r2.lines, ['{"c":3}']);
  assert.deepEqual(readNew(f, r2.offset).lines, []);
  writeFileSync(f, '{"z":0}\n'); // rewritten by a fresh init
  assert.deepEqual(readNew(f, r2.offset).lines, ['{"z":0}']);
});

test("watch: every event names its agent, and signals carry walker position", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-"));
  process.env.SEEMLY_AGENT = "walker /home";
  const g = open(dir, { origin: "https://app.example.com" });
  const { node } = g.addNode({ url: "https://app.example.com/home", label: "Home", entry: true, signature: ["a", "b"] });
  g.signal("walker.at", { node: node.id, element: 'button "Save"' });
  g.signal("walker.blocked", { node: node.id, reason: "login lost" });
  delete process.env.SEEMLY_AGENT;
  const evs = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(evs.every((e) => e.agent === "walker /home"));
  assert.deepEqual(evs.filter((e) => e.type.startsWith("walker.")).map((e) => e.type), ["walker.at", "walker.blocked"]);
  assert.equal(evs.find((e) => e.type === "walker.at").element, 'button "Save"');
});
