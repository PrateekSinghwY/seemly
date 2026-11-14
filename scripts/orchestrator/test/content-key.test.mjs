// Node identity for overlays, modals, menus and states carries a content key (title plus the
// sorted names of the surface's controls), so look-alike surfaces with different words split:
//   /conf/   one confirm dialog filled two ways (Approve / Sign-off): two nodes, one template,
//            each opener's edge at its own node; one team list filled with two sets of rows:
//            one node
//   unit     pages keep URL + skeleton; an older graph's keyless overlay loads as it was and
//            `O requeue --kind` puts it (and what opens it) back on the frontier
// The walker part needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph } from "../graph.mjs";
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

test("identity: a keyed overlay splits by content key; a page ignores it", () => {
  const g = Graph.create();
  const a = g.addNode({ url: "https://a.test/t", signature: ["dlg"], state: "modal", kind: "modal", contentKey: "k1" }).node;
  const b = g.addNode({ url: "https://a.test/t", signature: ["dlg"], state: "modal", kind: "modal", contentKey: "k2" }).node;
  assert.notEqual(a.id, b.id, "two content keys, two nodes");
  assert.equal(a.template, b.template, "one template");
  const p1 = g.addNode({ url: "https://a.test/p", signature: ["pg"], contentKey: "x" }).node;
  const p2 = g.addNode({ url: "https://a.test/p", signature: ["pg"], contentKey: "y" }).node;
  assert.equal(p1.id, p2.id, "a page is URL + skeleton only");
  assert.equal(p1.contentKey, undefined);
});

test("old graphs: a keyless overlay loads as it was; requeue --kind re-expands it and its opener", () => {
  const g = Graph.create();
  const home = g.addNode({ url: "https://a.test/t", signature: ["pg"], entry: true }).node;
  const old = g.addNode({ url: "https://a.test/t", signature: ["dlg"], state: "modal:Approve", kind: "modal" }).node;
  const keyed = g.addNode({ url: "https://a.test/t", signature: ["dlg2"], state: "menu:x", kind: "menu", contentKey: "k" }).node;
  g.addEdge({ from: home.id, to: old.id, kind: "click", element: { name: "Approve" } });
  g.addEdge({ from: home.id, to: keyed.id, kind: "click", element: { name: "More" } });
  g.next();
  for (const n of [home, old, keyed]) g.setStatus(n.id, "closed");
  const dir = mkdtempSync(join(tmpdir(), "seemly-ckey-"));
  save(g, dir);
  const back = open(dir, {});
  assert.equal(back.node(old.id).contentKey, undefined, "loads without a key, same id");
  assert.equal(back.node(old.id).status, "closed");
  const said = O(["requeue", "--kind", "overlay,modal,menu,state", "--dir", dir]);
  assert.match(said, /requeued 2 node/);
  const g2 = open(dir, {});
  assert.equal(g2.node(old.id).status, "frontier", "the keyless modal is re-expanded");
  assert.equal(g2.node(home.id).status, "frontier", "and the page that opens it, so the split is read");
  assert.equal(g2.node(keyed.id).status, "closed", "a node that has its key stays closed");
});

describe("walker on /conf/", { skip, timeout: 600_000 }, () => {
  let site;
  let g;
  before(async () => {
    site = await start();
    const dir = mkdtempSync(join(tmpdir(), "seemly-ckey-walk-"));
    const profile = join(dir, "profile");
    const ex = await import("../explore.mjs");
    g = open(dir, {});
    Object.assign(g.data.meta, { target: `${site.base}/conf/`, origin: site.base, prefix: "/conf" });
    await ex.readEntry(g, `${site.base}/conf/`, { profile });
    save(g, dir);
    await ex.explore(g, dir, { profile, maxNodes: 20, retries: 3, backoffMs: 50, log: () => {} });
  });
  after(() => site?.server.close());

  const nodes = () => Object.values(g.data.nodes);
  const edges = () => Object.values(g.data.edges);

  test("two confirms with one markup and different words: two nodes, one template, each edge at its own", () => {
    const home = nodes().find((n) => n.kind === "page" && n.entry);
    const to = (name) => edges().filter((e) => e.from === home.id && e.element.name === name && e.kind === "click").map((e) => g.data.nodes[e.to]);
    const [approve] = to("Approve");
    const [signoff] = to("Sign-off period");
    assert.ok(approve && signoff, "both openers have an edge");
    assert.equal(to("Approve").length, 1);
    assert.equal(to("Sign-off period").length, 1);
    assert.equal(approve.kind, "modal");
    assert.equal(signoff.kind, "modal");
    assert.notEqual(approve.id, signoff.id, "two nodes");
    assert.equal(approve.template, signoff.template, "one template");
    assert.match(approve.label, /Approve timecard/);
    assert.match(signoff.label, /Sign-off/);
    for (const n of [approve, signoff]) assert.equal(n.status, "closed", `${n.label} walked`);
  });

  test("a list overlay whose rows differ only by data stays one node", () => {
    const home = nodes().find((n) => n.kind === "page" && n.entry);
    const targets = new Set(edges().filter((e) => e.from === home.id && /^Team [AB]$/.test(e.element.name) && e.kind === "click").map((e) => e.to));
    assert.equal(targets.size, 1, "Team A and Team B open one node");
  });
});
