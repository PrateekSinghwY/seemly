import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { dijkstra, pathTo, similarity, stronglyConnected, topoOrder } from "../algorithms.mjs";
import { Graph, canonicalUrl, nodeId } from "../graph.mjs";
import { IndexedHeap } from "../heap.mjs";
import { open, readEvents, save } from "../store.mjs";

const SHELL = ["html/body/header", "html/body/header/nav", "html/body/footer"];
const SCORES = [...SHELL, "main/section.scores", "main/section.scores/card", "main/section.scores/card", "main/aside"];
const ARTICLE = [...SHELL, "main/article/h1", "main/article/p", "main/article/p", "main/article/p", "main/article/figure"];
const MODAL = ["dialog/h2", "dialog/form/label", "dialog/form/input", "dialog/button"];
const mod = { header: ["header", "header/nav", "header/nav/a"], scores: ["section", "section/card"], story: ["article", "article/p"] };

function sample() {
  const g = Graph.create({ target: "https://example.test/" });
  const nba = g.addNode({ url: "https://example.test/nba/scoreboard", signature: SCORES, entry: true, modules: [mod.header, mod.scores], interactive: 30 }).node;
  const wnba = g.addNode({ url: "https://example.test/wnba/scoreboard", signature: SCORES, modules: [mod.header, mod.scores], interactive: 30 }).node;
  const story = g.addNode({ url: "https://example.test/story/1", signature: ARTICLE, modules: [mod.header, mod.story], interactive: 5 }).node;
  const modal = g.addNode({ url: "https://example.test/nba/scoreboard", state: "settings", signature: MODAL, kind: "modal", interactive: 3 }).node;
  g.addEdge({ from: nba.id, to: wnba.id, kind: "navigation", element: { name: "WNBA" } });
  g.addEdge({ from: nba.id, to: story.id, kind: "click", element: { name: "Recap" } });
  g.addEdge({ from: wnba.id, to: nba.id, kind: "navigation", element: { name: "NBA" } });
  g.addEdge({ from: nba.id, to: modal.id, kind: "click", element: { name: "Settings" } });
  return { g, nba, wnba, story, modal };
}

test("heap: pop order and in-place priority update", () => {
  const prio = { a: 5, b: 3, c: 9 };
  const h = new IndexedHeap((x, y) => prio[x] - prio[y]);
  for (const k of Object.keys(prio)) h.push(k, k);
  prio.c = 1;
  h.update("c");
  h.delete("b");
  assert.deepEqual([h.pop(), h.pop(), h.pop()], ["c", "a", undefined]);
});

test("canonical url drops tracking params and fragment, sorts the query", () => {
  assert.equal(canonicalUrl("https://x.test/a/?z=1&utm_source=t&a=2#top"), "https://x.test/a?a=2&z=1");
  assert.equal(nodeId("https://x.test/a?utm_medium=x", ["p"]), nodeId("https://x.test/a", ["p"]));
});

test("similarity: same skeleton 1, unrelated 0", () => {
  assert.equal(similarity(SCORES, SCORES), 1);
  assert.equal(similarity(MODAL, SHELL), 0);
  assert.ok(similarity(SCORES, ARTICLE) < 0.92);
});

test("dedupe: the same surface twice is one node; same edge twice is one edge", () => {
  const { g, nba, wnba } = sample();
  assert.equal(g.addNode({ url: "https://example.test/nba/scoreboard?utm_source=x", signature: SCORES }).isNew, false);
  assert.equal(g.addEdge({ from: nba.id, to: wnba.id, kind: "navigation", element: { name: "WNBA" } }).isNew, false);
  assert.equal(g.stats().nodes, 4);
});

test("templates: two leagues of one page are one template; an article is another", () => {
  const { g, nba, wnba, story } = sample();
  assert.equal(nba.template, wnba.template);
  assert.notEqual(nba.template, story.template);
  assert.deepEqual(g.data.templates[nba.template].members, [nba.id, wnba.id]);
});

test("shell = modules on every entry node", () => {
  const { g, nba } = sample();
  assert.deepEqual(g.shell(), [nba.modules[0]]);
});

test("frontier: entry first, then the most-linked template, then cheaper", () => {
  const { g, nba, wnba, story, modal } = sample();
  const order = g.frontierOrder();
  assert.equal(order[0], nba.id);
  // wnba's template has 2 in-edges (wnba + nba back-link); story and modal have 1 each; modal is cheaper.
  assert.deepEqual(order.slice(1), [wnba.id, modal.id, story.id]);
  assert.equal(g.next().id, nba.id);
  assert.equal(g.node(nba.id).status, "expanding");
});

test("a node reachable only through a write is expanded last", () => {
  const { g, nba } = sample();
  const saved = g.addNode({ url: "https://example.test/nba/scoreboard", state: "saved", signature: ["div/toast"], interactive: 0 }).node;
  g.addEdge({ from: nba.id, to: saved.id, kind: "write", element: { name: "Save" } });
  const order = g.frontierOrder();
  assert.equal(order.at(-1), saved.id);
  assert.equal(g.route(saved.id), null);
});

test("route: cheapest replay path, never through a write", () => {
  const { g, nba, story } = sample();
  const deep = g.addNode({ url: "https://example.test/story/1", state: "share", signature: ["dialog/share"] }).node;
  g.addEdge({ from: story.id, to: deep.id, kind: "click", element: { name: "Share" } });
  g.addEdge({ from: nba.id, to: deep.id, kind: "write", element: { name: "Post" } });
  assert.deepEqual(g.route(deep.id).map((e) => e.element.name), ["Recap", "Share"]);
  assert.equal(g.routes()[deep.id].cost, 2);
  assert.equal(g.node(deep.id).depth, 2);
});

test("depth relaxes downstream when a shorter path appears later", () => {
  const g = Graph.create();
  const a = g.addNode({ url: "https://x.test/a", signature: ["a"], entry: true }).node;
  const b = g.addNode({ url: "https://x.test/b", signature: ["b"] }).node;
  const c = g.addNode({ url: "https://x.test/c", signature: ["c"] }).node;
  const d = g.addNode({ url: "https://x.test/d", signature: ["d"] }).node;
  g.addEdge({ from: b.id, to: c.id, kind: "click" });
  g.addEdge({ from: c.id, to: d.id, kind: "click" });
  assert.equal(d.depth, Infinity);
  g.addEdge({ from: a.id, to: b.id, kind: "click" });
  assert.deepEqual([b.depth, c.depth, d.depth], [1, 2, 3]);
});

test("build order: shell, shared modules, then templates; dependencies always first", () => {
  const { g, nba, story } = sample();
  const order = g.buildOrder();
  assert.equal(order[0], "shell");
  const at = (u) => order.indexOf(u);
  for (const m of nba.modules.slice(1)) assert.ok(at(m) < at(nba.template));
  for (const m of story.modules.slice(1)) assert.ok(at(m) < at(story.template));
});

test("topoOrder reports the cycle", () => {
  const deps = new Map([["a", ["c"]], ["b", ["a"]], ["c", ["b"]], ["d", []]]);
  assert.throws(() => topoOrder(["a", "b", "c", "d"], deps), /dependency cycle: .*a.*b.*c|cycle/);
});

test("loops: back-links form one strongly connected group", () => {
  const { g, nba, wnba } = sample();
  const loops = g.loops();
  assert.equal(loops.length, 1);
  assert.deepEqual(new Set(loops[0]), new Set([nba.id, wnba.id]));
  assert.equal(stronglyConnected(["x"], () => []).length, 1);
});

test("dijkstra prefers cheap hovers over clicks", () => {
  const adj = { s: [["a", 1], ["b", 0.5]], a: [["t", 1]], b: [["t", 0.5]], t: [] };
  const res = dijkstra(["s"], (u) => adj[u].map(([to, cost]) => ({ to, cost, edge: { from: u, to } })));
  assert.equal(res.dist.get("t"), 1);
  assert.deepEqual(pathTo(res, "t").map((e) => e.to), ["b", "t"]);
});

test("termination: closed only when the frontier is empty and nothing is mid-expansion", () => {
  const { g } = sample();
  assert.equal(g.isClosed(), false);
  let n;
  while ((n = g.next())) {
    assert.equal(g.isClosed(), false);
    g.setStatus(n.id, "closed");
  }
  assert.equal(g.isClosed(), true);
});

test("store: round trip survives Infinity, requeues a crashed expansion, logs events", () => {
  const dir = mkdtempSync(join(tmpdir(), "seemly-graph-"));
  const g = open(dir, { target: "https://example.test/" });
  const a = g.addNode({ url: "https://x.test/a", signature: ["a"], entry: true }).node;
  const b = g.addNode({ url: "https://x.test/b", signature: ["b"] }).node;
  g.addEdge({ from: a.id, to: b.id, kind: "write" });
  g.next();
  save(g, dir);
  const back = open(dir);
  assert.equal(back.node(a.id).status, "frontier");
  assert.equal(back.node(b.id).depth, Infinity);
  assert.equal(back.data.edges[Object.keys(back.data.edges)[0]].cost, Infinity);
  assert.deepEqual(readEvents(dir).map((e) => e.type), ["template.added", "node.added", "template.added", "node.added", "edge.added", "node.status"]);
  assert.ok(JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")).meta.updated);
});
