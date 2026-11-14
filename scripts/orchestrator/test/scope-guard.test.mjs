// A scope map that matches nothing must never close the graph unwalked:
//   units     unscoped (no rule matched) vs out of scope (a rule tagged another scope): queue
//             order, counts, coverage; `status` shows unscoped and shallow counts;
//             `requeue --shallow`; `explore --strict-scope` exits 4 before a browser opens
//   /spa/     a walk whose map was written for another site's URLs walks every node fully and
//             warns; an explicitly out-of-scope area still closes shallowly; strictScope throws
// The browser tests need Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph } from "../graph.mjs";
import { open, save } from "../store.mjs";
import { start } from "./fixture/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
const O = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [join(here, "..", "run.mjs"), ...args], { env: { ...process.env, RL_REPO: repo }, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }),
    ),
  );
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

/** An entry, one in-scope page, one unscoped page, one page a rule puts in another scope. */
function sample() {
  const g = Graph.create();
  Object.assign(g.data.meta, { target: "https://a.test/app/", origin: "https://a.test", prefix: "/app" });
  const home = g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true, label: "Home" }).node;
  const other = g.addNode({ url: "https://a.test/app/other", signature: ["other"], label: "Other" }).node;
  const admin = g.addNode({ url: "https://a.test/app/admin", signature: ["admin"], label: "Admin" }).node;
  const mine = g.addNode({ url: "https://a.test/app/mine", signature: ["mine"], label: "Mine" }).node;
  for (const n of [other, admin, mine]) g.addEdge({ from: home.id, to: n.id, kind: "navigation", element: { name: n.label } });
  g.setWalkScope({ rules: [{ scope: "S01", url: "^/app/mine" }, { scope: "S09", url: "^/app/admin" }], ids: ["S01"] });
  return { g, home, other, admin, mine };
}

test("walk scope: unscoped is not out of scope; queue order is in, unscoped, out", () => {
  const { g, home, other, admin, mine } = sample();
  assert.equal(g.outOfWalk(g.node(admin.id)), true, "a rule tagged it with another scope");
  assert.equal(g.outOfWalk(g.node(other.id)), false, "no rule matched: unscoped, walked fully");
  assert.equal(g.inWalk(g.node(other.id)), false);
  assert.deepEqual([g.next(), g.next(), g.next(), g.next()].map((n) => n.id), [home.id, mine.id, other.id, admin.id]);
  assert.deepEqual(g.walkCounts(), { in: 1, unscoped: 2, out: 1, shallow: 0 });
  assert.deepEqual(g.scopeCoverage(), { entries: { matched: 0, total: 1 }, walked: { matched: 0, total: 0 } });
});

test("status shows unscoped and shallow counts; requeue --shallow puts shallow nodes back", async () => {
  const { g, home, other, admin, mine } = sample();
  for (const n of [home, other, admin, mine]) g.setStatus(n.id, "closed");
  g.annotate(admin.id, { shallow: true, candidateKeys: [] });
  g.annotate(other.id, { shallow: true, candidateKeys: [] });
  const dir = mkdtempSync(join(tmpdir(), "scope-guard-"));
  save(g, dir);
  const st = await O(["status", "--dir", dir]);
  assert.match(st.out, /CLOSED \(2 closed shallow, not walked\)/);
  assert.match(st.out, /WALK\s+scope S01 · in 1 · unscoped 2 · out 1 · shallow 2/);
  const rq = await O(["requeue", "--shallow", "--dir", dir]);
  assert.equal(rq.code, 0, rq.out);
  assert.match(rq.out, /requeued 2 shallow node\(s\)/);
  const back = open(dir, {});
  for (const id of [admin.id, other.id]) {
    assert.equal(back.node(id).status, "frontier");
    assert.ok(!back.node(id).info.shallow);
  }
  assert.equal(back.node(home.id).status, "closed", "a fully walked node stays closed");
  assert.match((await O(["status", "--dir", dir])).out, /frontier 2[^\n]*\n[\s\S]*shallow 0/);
});

test("explore --strict-scope exits 4 on a map written for another site's URLs, before a browser opens", async () => {
  const g = Graph.create();
  Object.assign(g.data.meta, { target: "https://a.test/app/", origin: "https://a.test", prefix: "/app" });
  g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true, label: "Home" });
  const dir = mkdtempSync(join(tmpdir(), "scope-strict-"));
  save(g, dir);
  const map = join(dir, "scope.json");
  writeFileSync(map, JSON.stringify({ rules: [{ scope: "S01", url: "^/wfm/timecards" }] }));
  const r = await O(["explore", "--dir", dir, "--scope-map", map, "--scope", "S01", "--strict-scope"]);
  assert.equal(r.code, 4, r.out);
  assert.match(r.out, /WARNING: scope map matches 0 of 1 entry pages; is it written for this site's URLs\?/);
  assert.match(r.out, /STOPPED \(--strict-scope\)/);
});

async function walk(walkScope, extra = {}) {
  const site = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-scope-"));
  const profile = join(dir, "profile");
  const ex = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${site.base}/spa/`, origin: site.base, prefix: "/spa" });
  await ex.readEntry(g, `${site.base}/spa/`, { profile });
  save(g, dir);
  const logs = [];
  let error = null;
  try {
    await ex.explore(g, dir, { profile, maxNodes: 12, widths: "off", stateBound: 2, walkScope, log: (s) => logs.push(s), ...extra });
  } catch (e) {
    error = e;
  }
  site.server.close();
  return { g, dir, logs, error, ex, hits: site.hits };
}

describe("walker on /spa/ with a scope map for another site's URLs", { skip, timeout: 600_000 }, () => {
  let w;
  before(async () => {
    // The clone's routes, not this site's: no rule matches any node here.
    w = await walk({ rules: [{ scope: "IN", url: "^/app/" }, { scope: "ADMIN", url: "^/admin" }], ids: ["IN"] });
  });

  test("unscoped nodes are walked fully, never closed shallow", () => {
    assert.equal(w.error, null);
    const closed = Object.values(w.g.data.nodes).filter((n) => n.status === "closed");
    assert.ok(closed.length >= 5, `${closed.length} closed`);
    for (const n of closed) {
      assert.equal(n.walkScope, null, `${n.label} unscoped`);
      assert.ok(!n.info.shallow, `${n.label} not shallow`);
      assert.ok(existsSync(join(w.dir, n.info.artifacts, "screenshot.png")), `${n.label} captured`);
    }
    const app = closed.find((n) => n.kind === "page" && /\/spa\/app$/.test(n.url));
    assert.ok(app && Object.values(w.g.data.edges).some((e) => e.from === app.id), "the app page fired its elements");
    assert.ok(w.hits.admin.some((p) => /\/a\d/.test(p)), "the admin area was expanded too");
  });

  test("the coverage warning is printed", () => {
    assert.ok(w.logs.some((l) => /^WARNING: scope map matches 0 of 1 entry pages; is it written for this site's URLs\?/.test(l)), w.logs.join("\n"));
    assert.ok(w.logs.some((l) => /^WARNING: scope map matches 0 of \d+ nodes walked so far/.test(l)));
  });

  test("strictScope throws ScopeCoverageError before any node is walked", async () => {
    const s = await walk({ rules: [{ scope: "IN", url: "^/app/" }], ids: ["IN"] }, { strictScope: true });
    assert.ok(s.error instanceof s.ex.ScopeCoverageError, String(s.error));
    assert.equal(Object.values(s.g.data.nodes).filter((n) => n.status === "closed").length, 0);
  });
});

describe("walker on /spa/: an explicitly out-of-scope area still closes shallow", { skip, timeout: 600_000 }, () => {
  let w;
  before(async () => {
    w = await walk({ rules: [{ scope: "ADMIN", url: "^/spa/admin" }], ids: ["IN"] }, { maxNodes: 40 });
  });

  test("admin (another scope) is shallow; unscoped pages are walked fully", () => {
    const nodes = Object.values(w.g.data.nodes);
    const admin = nodes.find((n) => n.kind === "page" && /\/spa\/admin$/.test(n.url));
    assert.equal(admin.status, "closed");
    assert.ok(admin.info.shallow);
    assert.ok(!w.hits.admin.some((p) => /\/a\d/.test(p)), "nothing under it was loaded");
    const app = nodes.find((n) => n.kind === "page" && /\/spa\/app$/.test(n.url));
    assert.equal(app.walkScope, null);
    assert.equal(app.status, "closed");
    assert.ok(!app.info.shallow);
    assert.deepEqual(w.g.walkCounts().shallow, 1);
  });
});
