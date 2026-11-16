// Phase D run the way a long build runs it: with a relative --clone from another cwd, and as
// several verify processes on one clone dir at once.
//   - a relative --clone (and a relative --writes) still runs the writes round trip: every path
//     handed to write_roundtrip.mjs, which runs in its own folder, is absolute
//   - a write_roundtrip child that crashes leaves its error in the check record, not "Node.js vX"
//   - two concurrent `O verify --node` runs and two concurrent `--shard i/2` runs each keep both
//     results in graph.json, and `O verify --merge` rebuilds the graph from the pair summaries
// Needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { mergeVerify, outputTail, parseShard, withVerifyLock } from "../verify.mjs";
import { startPair } from "./fixture/pair.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

const O = (args, { cwd } = {}) =>
  new Promise((resolve) =>
    execFile(process.execPath, [join(here, "..", "run.mjs"), ...args], { cwd, env: { ...process.env, RL_REPO: repo }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }),
    ),
  );

async function walk(base) {
  const dir = mkdtempSync(join(tmpdir(), "seemly-vpar-"));
  const keyboards = join(dir, "keyboards.json");
  writeFileSync(keyboards, JSON.stringify({ rl: "fixture", product: "fixture", shortcuts: [{ keys: "alt+m", action: "open the quick menu", implemented: true }] }));
  const profile = join(dir, "profile");
  const { open, save } = await import("../store.mjs");
  const { explore, readEntry } = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${base}/app/`, origin: base, prefix: "/app" });
  await readEntry(g, `${base}/app/`, { profile });
  save(g, dir);
  const r = await explore(g, dir, { profile, maxNodes: 60, keyboards, log: () => {} });
  assert.ok(r.closed, `walk of ${base} closed`);
  return dir;
}

const graphOf = (dir) => JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
const NOTE = {
  at: "/app/reports", name: "save note",
  write: { method: "POST", path: "/api/notes", body: { text: "Quarterly review" } },
  expect: [{ path: "/api/notes", pointer: "/text", equals: "Quarterly review" }],
  page: { path: "/app/reports", text: "Quarterly review" },
  restore: { method: "POST", path: "/api/notes", body: { text: "" } },
};

let sites;
let ref;
let clone;
let home;
let reports;
before(async () => {
  if (skip) return;
  sites = await startPair();
  ref = await walk(sites.ref.base);
  clone = await walk(sites.clone.base);
  assert.equal((await O(["compare", "--ref", ref, "--clone", clone])).code, 0);
  const pairs = JSON.parse(readFileSync(join(clone, "pairs.json"), "utf8")).pairs;
  const page = (re) => pairs.find((p) => p.kind === "page" && re.test(new URL(p.ref.url).pathname));
  home = page(/^\/app\/$/);
  reports = page(/^\/app\/reports$/);
  assert.ok(home && reports, "home and reports pair");
}, { timeout: 900_000 });
after(async () => {
  await sites?.close();
});

test("a relative --clone and --writes still run the writes round trip", { skip, timeout: 600_000 }, async () => {
  writeFileSync(join(clone, "writes.json"), JSON.stringify([NOTE]));
  // run from the clone dir's parent, naming the clone (and its writes spec) relative to it
  const r = await O(["verify", "--ref", ref, "--clone", basename(clone), "--node", reports.ref.id, "--writes", join(basename(clone), "writes.json")], { cwd: dirname(clone) });
  const rec = JSON.parse(readFileSync(join(clone, "verify", reports.clone.id, "writes.json"), "utf8"));
  assert.equal(rec.ran, true, `writes ran (${rec.reason})\n${r.out}`);
  assert.equal(rec.status, "pass", rec.reason);
  assert.equal(graphOf(clone).nodes[reports.clone.id].verify.writes.status, "pass");
});

test("a write_roundtrip child that crashes records its error, not the Node version", { skip, timeout: 600_000 }, async () => {
  // a row whose write has no method: write_roundtrip.mjs throws reading it
  writeFileSync(join(clone, "writes-bad.json"), JSON.stringify([{ at: "/app/reports", name: "broken row", write: null }]));
  await O(["verify", "--ref", ref, "--clone", clone, "--node", reports.ref.id, "--writes", join(clone, "writes-bad.json")]);
  const rec = JSON.parse(readFileSync(join(clone, "verify", reports.clone.id, "writes.json"), "utf8"));
  assert.notEqual(rec.status, "pass");
  assert.match(rec.reason, /exit 1/, rec.reason);
  assert.match(rec.reason, /TypeError|Cannot read/, `the child's error is in the record: ${rec.reason}`);
  assert.doesNotMatch(rec.reason.replace(/.*did not run \(|.*crashed \(/, ""), /^exit 1: Node\.js v/);
  writeFileSync(join(clone, "writes.json"), JSON.stringify([NOTE]));
});

test("two concurrent verify runs on one clone dir keep both results; shards merge; --merge rebuilds", { skip, timeout: 900_000 }, async () => {
  const reset = () => {
    const g = graphOf(clone);
    for (const id of [home.clone.id, reports.clone.id]) delete g.nodes[id].verify;
    writeFileSync(join(clone, "graph.json"), JSON.stringify(g));
  };
  const both = () => {
    const g = graphOf(clone);
    return [home, reports].map((p) => g.nodes[p.clone.id].verify?.ref);
  };

  // two --node runs at once: each used to save its own stale copy of the graph over the other's
  reset();
  await Promise.all([home, reports].map((p) => O(["verify", "--ref", ref, "--clone", clone, "--node", p.ref.id])));
  assert.deepEqual(both(), [home.ref.id, reports.ref.id], "both concurrent --node results are in graph.json");

  // two shards over the whole dir at once: every pair verified once, every result kept
  reset();
  const shards = await Promise.all(["0/2", "1/2"].map((s) => O(["verify", "--ref", ref, "--clone", clone, "--shard", s])));
  const ran = shards.map((s) => s.out.split("\n").filter((l) => /^[✓✗] /.test(l)).length);
  const pairs = JSON.parse(readFileSync(join(clone, "pairs.json"), "utf8")).pairs;
  assert.equal(ran[0] + ran[1], pairs.length, `the shards split the pairs (${ran})`);
  assert.ok(ran[0] && ran[1], `each shard ran pairs (${ran})`);
  const g = graphOf(clone);
  for (const p of pairs) assert.equal(g.nodes[p.clone.id].verify?.ref, p.ref.id, `${p.clone.id} kept its shard's result`);
  assert.ok(!existsSync(join(clone, "verify.lock")), "the lock is released");

  // a shard that died before its merge: the pair summaries rebuild the graph
  reset();
  const m = await O(["verify", "--merge", "--clone", clone]);
  assert.equal(m.code, 0, m.out);
  assert.deepEqual(both(), [home.ref.id, reports.ref.id], "--merge restored both from verify/<node>/verify.json");
});

test("shard spec, lock and merge without a browser", () => {
  assert.deepEqual(parseShard("1/3"), { i: 1, n: 3 });
  assert.equal(parseShard(undefined), null);
  for (const bad of ["3/3", "a/2", "1", "0/0"]) assert.throws(() => parseShard(bad));
  assert.equal(outputTail({ code: 1, stdout: "", stderr: "file:///x.mjs:4\nTypeError: boom\n    at y\n\nNode.js v22.1.0\n" }), "exit 1: file:///x.mjs:4 | TypeError: boom |     at y");

  const dir = mkdtempSync(join(tmpdir(), "seemly-vlock-"));
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ meta: {}, nodes: { a: { id: "a", status: "closed" }, b: { id: "b", status: "closed" } }, edges: {} }));
  mergeVerify(dir, [{ id: "a", verify: { ref: "ra", at: "2026-01-02T00:00:00Z", passed: true } }]);
  mergeVerify(dir, [{ id: "b", verify: { ref: "rb", at: "2026-01-02T00:00:00Z", passed: false } }]);
  // an older summary never replaces a newer one
  mergeVerify(dir, [{ id: "a", verify: { ref: "old", at: "2026-01-01T00:00:00Z", passed: false } }]);
  const g = graphOf(dir);
  assert.equal(g.nodes.a.verify.ref, "ra");
  assert.equal(g.nodes.a.status, "verified");
  assert.equal(g.nodes.b.verify.ref, "rb");
  // a lock left by a dead pid is taken over
  writeFileSync(join(dir, "verify.lock"), "999999");
  assert.equal(withVerifyLock(dir, () => 7, { timeoutMs: 2000 }), 7);
  assert.ok(!existsSync(join(dir, "verify.lock")));
});
