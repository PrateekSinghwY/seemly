// A schedule planner does not hold the walk (SKILL.md section 4, "Data chips" and "Node budget").
// graph-clone-r5 spent 3.5 hours on one planner of ~1,400 elements, clicking every shift chip
// ("<person>, Fri 11/20, 7:30 PM-4:00 AM", about 30 s each) with graph.json unsaved the whole time,
// while allowed-posts.jsonl logged every allowed request (14,854 rows). Proven here:
//   unit     chips with different names but one normalised pattern group by (role, css, pattern);
//            a toolbar of different commands does not; allowed-posts rows dedupe by rule
//   /plan/   60 shift chips: at most K clicked, the rest `sampled-out`; 24 empty day cells alike;
//            the four toolbar commands all fire
//   budget   a tiny node budget closes the node partial (the rest `unfired: budget`) with graph.json
//            saved mid-node; `status` shows it, `requeue --partial` walks it again in full
//   compact  `O compact-allowed` rewrites an old per-request log to one row per rule
// The walker parts need Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROW_SAMPLE, clickGroups } from "../bound.mjs";
import { AllowedLog, compactAllowed } from "../safety.mjs";
import { open, save } from "../store.mjs";
import { start } from "./fixture/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const O = (args) => execFileSync(process.execPath, [join(here, "..", "run.mjs"), ...args], { encoding: "utf8" });

const repo = process.env.RL_REPO || process.cwd();
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

const CHIP = /^[A-Z][a-z]+, [A-Z][a-z]+, (Mon|Tue|Wed|Thu|Fri) 11\/\d\d, /;
const EMPTY = /^[A-Z][a-z]+, [A-Z][a-z]+, (Sun|Sat) 11\/\d\d$/;
const TOOLBAR = ["Approve", "Sign-off", "Refresh", "Team A"];

test("click groups: data chips group by their normalised pattern; a command toolbar does not", () => {
  const people = ["Doe, Alex", "Rivera, Sam", "Natarajan, Priya", "Lee, Jordan"];
  const cands = [];
  people.forEach((who, i) => {
    for (const [d, n] of [["Mon", 16], ["Tue", 17], ["Wed", 18]]) {
      cands.push({ role: "button", name: `${who}, ${d} 11/${n}, ${i + 1}:30 PM-${i + 4}:00 AM`, css: `table > tbody > tr:nth-of-type(${i + 1}) > td:nth-of-type(${n}) > div > button` });
    }
    cands.push({ role: "button", name: `${who}, Sun 11/15`, css: `table > tbody > tr:nth-of-type(${i + 1}) > td:nth-of-type(1) > button` });
  });
  TOOLBAR.forEach((name, i) => cands.push({ role: "button", name, css: `div.bar > button:nth-of-type(${i + 1})` }));
  const m = clickGroups(cands);
  const chip = m.get(cands[0].css);
  assert.equal(chip?.pattern, "<name>, <day> <date>, <time>-<time>");
  assert.equal(new Set(cands.filter((c) => CHIP.test(c.name)).map((c) => m.get(c.css)?.id)).size, 1, "every chip in one group");
  assert.equal(m.get(cands[3].css)?.pattern, "<name>, <day> <date>", "an empty day cell has its own pattern");
  for (const c of cands.filter((x) => TOOLBAR.includes(x.name))) assert.equal(m.get(c.css), undefined, `${c.name} keeps its own name`);
});

test("allowed-posts: each rule is logged once, by method, path template and phase", () => {
  const dir = mkdtempSync(join(tmpdir(), "seemly-allowed-"));
  const p = join(dir, "allowed-posts.jsonl");
  const log = new AllowedLog(p);
  for (let i = 0; i < 50; i++) log.add({ method: "POST", url: `http://x.test/api/v1/schedule/multi_read?i=${i}`, why: "allow-post rule", phase: i % 2 ? "load" : "action", node: `n_${i}` });
  for (let i = 0; i < 20; i++) log.add({ method: "PUT", url: `http://x.test/api/v1/cards/${i + 1}/home_card`, why: "allow-post rule", phase: "action" });
  log.add({ rule: "POST /api/v1/x (load)", learned: "load", why: "sent while the page loaded", example: "http://x.test/api/v1/x" });
  log.add({ rule: "POST /api/v1/x (load)", learned: "load", why: "again", example: "http://x.test/api/v1/x" });
  const rows = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 4, "multi_read at load and at action, home_card for every id, one learned rule");
  const again = new AllowedLog(p);
  assert.equal(again.add({ method: "POST", url: "http://x.test/api/v1/schedule/multi_read", phase: "load" }), false, "a reopened log knows its rules");
  assert.ok(again.rows.some((r) => r.rule === "POST /api/v1/x (load)"), "learned rules reload");
});

test("compact-allowed: an old per-request log is rewritten to one row per rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "seemly-compact-"));
  const p = join(dir, "allowed-posts.jsonl");
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(JSON.stringify({ method: "POST", url: "http://x.test/api/v1/schedule/multi_read", why: "allow-post rule", node: `n_${i % 7}`, element: null }));
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ method: "PUT", url: `http://x.test/api/v1/cards/${i}/home_card`, why: "allow-post rule", phase: "action" }));
  lines.push(JSON.stringify({ rule: "POST /api/v1/y", learned: "url", why: "names a read", example: "http://x.test/api/v1/y" }));
  lines.push("{not json");
  writeFileSync(p, lines.join("\n") + "\n");
  assert.equal(compactAllowed(readFileSync(p, "utf8")).after, 3);
  assert.match(O(["compact-allowed", "--dry-run", "--dir", dir]), /would compact .*: 342 row\(s\) -> 3 rule\(s\), 1 unreadable dropped/);
  assert.equal(readFileSync(p, "utf8").trim().split("\n").length, 342, "a dry run changes nothing");
  assert.match(O(["compact-allowed", "--dir", dir]), /compacted .*: 342 row\(s\) -> 3 rule\(s\)/);
  const rows = readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.method === "POST").seen, 300, "each kept row says how many it stood for");
  assert.match(O(["compact-allowed", "--dir", dir]), /3 row\(s\) -> 3 rule\(s\)/, "a second run changes nothing");
});

/** Walk /plan/ from a fresh dir; returns the graph, the dir and the planner's inventory. */
async function walk(site, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seemly-plan-"));
  const profile = join(dir, "profile");
  const ex = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${site.base}/plan/`, origin: site.base, prefix: "/plan" });
  await ex.readEntry(g, `${site.base}/plan/`, { profile });
  save(g, dir);
  await ex.explore(g, dir, { profile, maxNodes: 1, widths: "off", interactions: false, log: () => {}, ...opts });
  const home = Object.values(g.data.nodes).find((n) => n.entry);
  const inv = JSON.parse(readFileSync(join(dir, home.info.artifacts, "inventory.json"), "utf8"));
  return { g, dir, home, inv, profile };
}

describe("walker on /plan/: 60 shift chips, 24 empty cells, a command toolbar", { skip, timeout: 600_000 }, () => {
  let site;
  let inv;
  before(async () => {
    site = await start();
    ({ inv } = await walk(site));
  });
  after(() => site?.server.close());

  test("at most K chips clicked, the rest sampled-out with their group id", () => {
    const chips = inv.candidates.filter((r) => CHIP.test(r.name ?? ""));
    assert.equal(chips.length, 60);
    const fired = chips.filter((r) => !r.unfired);
    assert.ok(fired.length >= 1 && fired.length <= ROW_SAMPLE, `${fired.length} chips clicked`);
    const out = chips.filter((r) => r.unfired === "sampled-out");
    assert.equal(out.length, 60 - fired.length, "the rest are sampled out");
    assert.equal(new Set(out.map((r) => r.group)).size, 1, "one group");
  });

  test("at most K empty day cells clicked", () => {
    const cells = inv.candidates.filter((r) => EMPTY.test(r.name ?? ""));
    assert.equal(cells.length, 24);
    assert.ok(cells.filter((r) => !r.unfired).length <= ROW_SAMPLE);
    assert.equal(cells.filter((r) => r.unfired === "sampled-out").length, 24 - cells.filter((r) => !r.unfired).length);
  });

  test("every toolbar command fires", () => {
    for (const name of TOOLBAR) {
      const r = inv.candidates.find((x) => x.name === name);
      assert.ok(r && !r.unfired, `${name}: ${r?.unfired}`);
    }
  });
});

describe("node budget: a long node with a tiny budget closes partial, saved mid-node", { skip, timeout: 600_000 }, () => {
  let site;
  let run;
  before(async () => {
    site = await start();
    run = await walk(site, { nodeBudgetS: Number(process.env.SEEMLY_TEST_BUDGET_S ?? 8), saveEvery: 1, rowSample: 60 });
  });
  after(() => site?.server.close());

  test("the rest of the node is unfired: budget, and the node is closed partial", () => {
    const { g, home, inv } = run;
    const left = inv.candidates.filter((r) => r.unfired === "budget");
    const fired = inv.candidates.filter((r) => !r.unfired);
    assert.ok(fired.length >= 1, "some elements fired before the budget ran out");
    assert.ok(left.length >= 1, "the rest waits for requeue --partial");
    assert.equal(inv.invariant, "ok");
    const n = g.data.nodes[home.id];
    assert.equal(n.status, "closed");
    assert.equal(n.info.partial?.reason, "budget");
    assert.equal(n.info.partial?.retryable, true);
    assert.equal(n.info.partial?.unfired, left.length);
  });

  test("graph.json was saved while the node was still expanding", () => {
    const { dir, home } = run;
    const ev = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const closed = ev.findIndex((e) => e.type === "node.status" && e.id === home.id && e.to === "closed");
    const saves = ev.filter((e, i) => e.type === "walker.saved" && e.node === home.id && i < closed);
    assert.ok(saves.length >= 1, "at least one save inside the node's expansion");
  });

  test("status shows the partial count; requeue --partial walks it again in full", async () => {
    const { dir, home, profile } = run;
    assert.match(O(["status", "--dir", dir]), /PARTIAL 1 node\(s\) closed partial, \d+ element\(s\) left unfired/);
    assert.match(O(["requeue", "--partial", "--dir", dir]), /requeued 1 partial node/);
    const g = open(dir, {});
    assert.equal(g.data.nodes[home.id].status, "frontier");
    const ex = await import("../explore.mjs");
    await ex.explore(g, dir, { profile, maxNodes: 1, widths: "off", interactions: false, log: () => {}, nodeBudgetS: 0 });
    const n = g.data.nodes[home.id];
    assert.equal(n.status, "closed");
    assert.equal(n.info.partial, undefined, "walked in full");
    const inv = JSON.parse(readFileSync(join(dir, n.info.artifacts, "inventory.json"), "utf8"));
    assert.equal(inv.candidates.filter((r) => r.unfired === "budget").length, 0);
  });
});
