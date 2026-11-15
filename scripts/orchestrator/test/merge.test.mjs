// `O fork` / `O merge`: parallel walks of one app fold back into one graph.
//   the copy that got furthest wins each node, and its capture folder comes with it
//   edges and logs are unions; the frontier is re-read from the merged statuses
//   merge refuses while a walk holds the target
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph } from "../graph.mjs";
import { mergeData } from "../merge.mjs";
import { save } from "../store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const O = (args) => execFileSync(process.execPath, [join(here, "..", "run.mjs"), ...args], { encoding: "utf8" });

function base() {
  const g = Graph.create();
  const home = g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true }).node;
  const a = g.addNode({ url: "https://a.test/app/a", signature: ["a"] }).node;
  const b = g.addNode({ url: "https://a.test/app/b", signature: ["b"] }).node;
  g.addEdge({ from: home.id, to: a.id, kind: "click", element: { name: "A" } });
  g.addEdge({ from: home.id, to: b.id, kind: "click", element: { name: "B" } });
  g.next();
  g.setStatus(home.id, "closed");
  return { g, home, a, b };
}

test("mergeData: the furthest status wins per node, edges union, a tie keeps the target's", () => {
  const t = base();
  const w1 = new Graph(JSON.parse(JSON.stringify(t.g)));
  const w2 = new Graph(JSON.parse(JSON.stringify(t.g)));
  w1.frontier.delete(t.a.id); w1.setStatus(t.a.id, "closed");
  const c = w1.addNode({ url: "https://a.test/app/a/c", signature: ["c"] }).node;
  w1.addEdge({ from: t.a.id, to: c.id, kind: "click", element: { name: "C" } });
  w2.frontier.delete(t.b.id); w2.setStatus(t.b.id, "gap", "timeout");
  const into = JSON.parse(JSON.stringify(t.g));
  const taken = mergeData(into, [JSON.parse(JSON.stringify(w1)), JSON.parse(JSON.stringify(w2))]);
  assert.equal(into.nodes[t.a.id].status, "closed");
  assert.equal(into.nodes[t.b.id].status, "gap");
  assert.equal(into.nodes[c.id].status, "frontier");
  assert.equal(Object.keys(into.edges).length, 3);
  assert.deepEqual(taken[0].sort(), [t.a.id, c.id].sort());
  assert.deepEqual(taken[1], [t.b.id]);
  const merged = new Graph(into);
  assert.equal(merged.frontier.size, 1, "only c is left to walk");
});

test("fork and merge on disk: worker copies carry no capture folders; merge brings the walked ones back", () => {
  const root = mkdtempSync(join(tmpdir(), "merge-"));
  const main = join(root, "main");
  const t = base();
  save(t.g, main);
  mkdirSync(join(main, "nodes", t.home.id), { recursive: true });
  writeFileSync(join(main, "nodes", t.home.id, "dom.html"), "<p>home</p>");
  writeFileSync(join(main, "errors.jsonl"), '{"e":1}\n');
  const w = join(root, "w1");
  O(["fork", "--dir", main, "--out", w]);
  assert.ok(existsSync(join(w, "graph.json")));
  assert.ok(!existsSync(join(w, "nodes", t.home.id)), "no capture folders in a worker copy");
  const wg = new Graph(JSON.parse(readFileSync(join(w, "graph.json"), "utf8")));
  wg.frontier.delete(t.a.id); wg.setStatus(t.a.id, "closed");
  save(wg, w);
  mkdirSync(join(w, "nodes", t.a.id), { recursive: true });
  writeFileSync(join(w, "nodes", t.a.id, "dom.html"), "<p>a</p>");
  writeFileSync(join(w, "errors.jsonl"), '{"e":1}\n{"e":2}\n');
  const out = O(["merge", "--into", main, "--from", w]);
  assert.match(out, /1 node\(s\) taken, 1 capture folder\(s\), 1 log line\(s\); 3 nodes, frontier 1/);
  assert.equal(readFileSync(join(main, "nodes", t.a.id, "dom.html"), "utf8"), "<p>a</p>");
  assert.equal(readFileSync(join(main, "nodes", t.home.id, "dom.html"), "utf8"), "<p>home</p>");
  assert.equal(readFileSync(join(main, "errors.jsonl"), "utf8"), '{"e":1}\n{"e":2}\n');
});

test("merge refuses while a live walk holds the target", () => {
  const root = mkdtempSync(join(tmpdir(), "merge-lock-"));
  const main = join(root, "main");
  save(base().g, main);
  writeFileSync(join(main, "supervise.pid"), String(process.pid));
  assert.throws(() => O(["merge", "--into", main, "--from", main]), /walk running/);
});

import { NeverOpen } from "../safety.mjs";
test("never-open: worker copies share their parent's list, and a sibling's new row is seen at once", () => {
  const root = mkdtempSync(join(tmpdir(), "never-"));
  const main = join(root, "main");
  save(base().g, main);
  for (const w of ["w1", "w2"]) O(["fork", "--dir", main, "--out", join(root, w)]);
  const fork = JSON.parse(readFileSync(join(root, "w1", "fork.json"), "utf8"));
  const a = new NeverOpen(join(root, "w1", "never-open.jsonl"), { shared: [join(fork.parent, "never-open.jsonl")] });
  const b = new NeverOpen(join(root, "w2", "never-open.jsonl"), { shared: [join(fork.parent, "never-open.jsonl")] });
  assert.equal(b.match("https://a.test/app/#/logout-page"), null);
  a.add("https://a.test/app/#/logout-page", { why: "test" });
  assert.ok(b.match("https://a.test/app/#/logout-page"), "the sibling sees the new row without a restart");
  assert.ok(readFileSync(join(main, "never-open.jsonl"), "utf8").includes("logout-page"), "the parent keeps it for the merge");
});
