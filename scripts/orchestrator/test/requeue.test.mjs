import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph, gapReason, isRetryableReason } from "../graph.mjs";
import { save } from "../store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const O = (args) => execFileSync(process.execPath, [join(here, "..", "run.mjs"), ...args], { encoding: "utf8" });

/** One entry and five gap nodes, each with a different reason (or none). */
function gaps() {
  const g = Graph.create();
  const home = g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true }).node;
  const mk = (path, sig) => g.addNode({ url: `https://a.test${path}`, signature: [sig] }).node;
  const failed = mk("/app/a", "a");
  const timeout = mk("/app/b", "b");
  const none = mk("/app/c", "c");
  const ruled = mk("/app/d", "d");
  const external = g.addNode({ url: "https://example.org/help", signature: ["out-of-scope"], inScope: false }).node;
  for (const n of [failed, timeout, none, ruled]) g.addEdge({ from: home.id, to: n.id, kind: "click", element: { name: n.url } });
  g.next();
  g.setStatus(home.id, "closed");
  for (const n of [failed, timeout, none, ruled]) g.frontier.delete(n.id);
  g.setStatus(failed.id, "gap", "explore failed twice: replay: \"Open\" not found");
  g.setStatus(timeout.id, "gap", "timeout 45000ms exceeded");
  g.setStatus(none.id, "gap");
  g.setStatus(ruled.id, "gap", "human ruling: billing is out of this build");
  failed.attempts = 2;
  return { g, failed, timeout, none, ruled, external };
}

test("gap reasons: the walker's detail, the placeholder for out-of-scope, else none", () => {
  const { failed, none, external } = gaps();
  assert.match(gapReason(failed), /explore failed/);
  assert.equal(gapReason(none), null);
  assert.equal(gapReason(external), "out of scope");
  assert.ok(isRetryableReason(null), "a missing reason is retryable");
  assert.ok(isRetryableReason("explore failed twice: net::ERR_ABORTED"));
  assert.ok(!isRetryableReason("out of scope"));
  assert.ok(!isRetryableReason("human ruling: not in this build"));
  assert.ok(!isRetryableReason("metered: costs credits"));
});

test("requeueGaps: every retryable gap back on the frontier, attempts reset; rulings and out-of-scope stay", () => {
  const { g, failed, timeout, none, ruled, external } = gaps();
  const back = g.requeueGaps().map((n) => n.id).sort();
  assert.deepEqual(back, [failed.id, timeout.id, none.id].sort());
  for (const n of [failed, timeout, none]) assert.equal(g.node(n.id).status, "frontier");
  assert.equal(g.node(failed.id).attempts, 0);
  assert.equal(g.node(failed.id).detail, null);
  assert.equal(g.node(ruled.id).status, "gap");
  assert.equal(g.node(external.id).status, "gap");
  assert.equal(g.frontier.size, 3);
});

test("requeueGaps --reason narrows to one reason; a custom rule overrides the default", () => {
  const { g, timeout, ruled } = gaps();
  assert.deepEqual(g.requeueGaps({ reason: "TIMEOUT" }).map((n) => n.id), [timeout.id]);
  const all = gaps();
  const back = all.g.requeueGaps({ retryable: (r) => /ruling/.test(r ?? "") }).map((n) => n.id).sort();
  assert.deepEqual(back, [all.ruled.id, all.none.id].sort(), "the rule picks the ruling; a reasonless gap is always retried");
  assert.ok(ruled);
});

test("the walker's structured reason decides: its retryable flag wins over the text", () => {
  const { g, timeout, ruled } = gaps();
  g.node(timeout.id).gapReason = { code: "http-4xx", retryable: false, message: "HTTP 404 on /app/b" };
  g.node(ruled.id).gapReason = { code: "transient", retryable: true, message: "net::ERR_TIMED_OUT" };
  const back = g.requeueGaps().map((n) => n.id);
  assert.ok(!back.includes(timeout.id));
  assert.ok(back.includes(ruled.id));
  assert.equal(g.node(ruled.id).gapReason, undefined, "a requeued node drops its old reason");
  assert.equal(gapReason({ gapReason: { code: "out-of-scope", retryable: false, message: "https://example.org/x" } }), "out of scope: https://example.org/x");
});

test("O requeue --gaps [--reason] on a saved graph, judged by the walker's rule", () => {
  const { g, failed, timeout, none, ruled } = gaps();
  const dir = mkdtempSync(join(tmpdir(), "requeue-"));
  save(g, dir);
  assert.match(O(["requeue", "--gaps", "--reason", "explore failed", "--dir", dir]), /requeued 1 gap node/);
  let saved = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
  assert.equal(saved.nodes[failed.id].status, "frontier", "a replay failure is retryable to the walker");
  assert.match(O(["requeue", "--gaps", "--dir", dir]), /requeued 1 gap node/);
  saved = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
  assert.equal(saved.nodes[none.id].status, "frontier", "a gap with no reason is retried");
  assert.equal(saved.nodes[timeout.id].status, "gap", "a person's own reason is a ruling to the walker");
  assert.equal(saved.nodes[ruled.id].status, "gap");
  assert.equal(Object.values(saved.nodes).filter((n) => n.status === "frontier").length, 2);
});
