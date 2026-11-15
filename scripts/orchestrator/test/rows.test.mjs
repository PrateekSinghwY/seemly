// Data rows do not explode the graph (SKILL.md section 4, "Data rows"). A schedule planner with one
// chip per shift once minted a state per chip ("drag: <a person>, <a date>, <a shift>"), each then
// walked in full. Proven here:
//   unit     data tokens (names "Last, First", dates, weekdays, times, numbers) normalise to
//            placeholders, and the in-page copy of the rules (page-probe.mjs) equals bound.mjs's;
//            the row sampler takes K per row template, more only while each sample leads somewhere new
//   dedupe   `O dedupe` collapses an exploded graph into one node per row template, rewrites the
//            edges, keeps a closed sample, and leaves two different confirms apart
//   /rows/   a walk of a 50-row grid (each chip draggable and right-clickable) creates at most K
//            states per kind, with normalised titles; a drag that only moved a chip is closed
//            `same-as-parent`, not walked again; Approve and Sign-off stay two nodes
// The walker part needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROW_SAMPLE, normaliseData, rowGroups, rowSampler } from "../bound.mjs";
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

test("normalise: names, dates, weekdays, times and numbers become placeholders; command words stay", () => {
  assert.equal(normaliseData("Doe, Alex, Tue 11/17, 9:30 PM-6:00 AM"), "<name>, <day> <date>, <time>-<time>");
  assert.equal(normaliseData("Rivera, Sam, Sun 11/08, 6:30 PM-3:00 AM"), normaliseData("Doe, Alex, Tue 11/17, 9:30 PM-6:00 AM"));
  assert.equal(normaliseData("Shift glance: Natarajan, Priya J."), "Shift glance: <name>");
  assert.equal(normaliseData("Open Shifts, Thu 11/19, 5:30 AM-10:30 AM"), "Open Shifts, <day> <date>, <time>-<time>");
  assert.equal(normaliseData("Due 2026-11-17 and Nov 17, 2026"), "Due <date> and <date>");
  assert.equal(normaliseData("Load 25 more"), "Load # more");
  assert.equal(normaliseData("Approve timecard"), "Approve timecard");
  assert.notEqual(normaliseData("Approve timecard"), normaliseData("Sign-off"));
  assert.equal(normaliseData("Show, Hide, and Filter"), "Show, Hide, and Filter", "a list of words is not a person");
});

test("normalise: page-probe.mjs runs the same rules in the page as bound.mjs", () => {
  const rules = (file, name) => {
    const src = readFileSync(join(here, "..", file), "utf8");
    const at = src.indexOf(`const ${name} = [`);
    assert.ok(at >= 0, `${file} has ${name}`);
    return src.slice(src.indexOf("[", at), src.indexOf("];", at) + 1).replace(/\s+/g, "");
  };
  assert.equal(rules("page-probe.mjs", "TOKENS"), rules("bound.mjs", "DATA_TOKENS"));
});

test("row sampler: K per row template, more only while each sample leads somewhere new", () => {
  const css = (i) => ({ css: `table > tbody > tr:nth-of-type(${i}) > td > span` });
  assert.equal(rowGroups([css(1), css(2)]).size, 0, "two look-alikes are not data rows");
  assert.equal(rowGroups([css(1), css(2), css(3)]).size, 1);
  const store = {};
  const s = rowSampler(store);
  let fired = 0;
  for (let i = 0; i < 50; i++) if (s.take("p|drag|g")) fired++, s.lead("p|drag|g", "t1");
  assert.equal(fired, ROW_SAMPLE, "same lead every time: K samples");
  const s2 = rowSampler({});
  let n = 0;
  for (let i = 0; i < 50; i++) if (s2.take("k")) s2.lead("k", `t${n++}`);
  assert.equal(n, 30, "a new lead each time keeps sampling, up to STATE_BOUND");
  assert.equal(rowSampler(store).take("p|drag|g"), false, "the counts live in the store (graph meta): a resumed walk keeps them");
});

test("dedupe: an exploded graph collapses to one node per row template; confirms stay apart", () => {
  const g = Graph.create();
  const url = "https://a.test/planner";
  const home = g.addNode({ url, signature: ["pg"], entry: true, label: "Planner" }).node;
  const last = ["Doe", "Rivera", "Natarajan", "Lee", "Park"];
  const ids = [];
  for (let i = 0; i < 50; i++) {
    const name = `${last[i % 5]}, Alex, Tue 11/${10 + (i % 9)}, ${(i % 9) + 1}:30 PM-6:00 AM`;
    const n = g.addNode({ url, signature: ["pg", `x${i % 2}`], state: `drag:button:${name}`, kind: "state", label: `drag: ${name}`, contentKey: `k${i}` }).node;
    g.addEdge({ from: home.id, to: n.id, kind: "drag", element: { role: "button", name, css: `#main > table > tbody > tr:nth-of-type(${i + 1}) > td > button` } });
    ids.push(n.id);
  }
  // an exploded state walked further: a drag from it to another one, and a menu only it opens
  const menu = g.addNode({ url, signature: ["mn"], state: "menu:Tools", kind: "menu", label: "menu: Tools", contentKey: "m" }).node;
  g.addEdge({ from: ids[7], to: ids[8], kind: "drag", element: { role: "button", name: "x", css: "#main > table > tbody > tr:nth-of-type(9) > td > button" } });
  g.addEdge({ from: ids[7], to: menu.id, kind: "click", element: { role: "button", name: "Tools", css: "#main > nav > button" } });
  const approve = g.addNode({ url, signature: ["dlg"], state: "modal:Approve timecard", kind: "modal", label: "modal: Approve timecard", contentKey: "a" }).node;
  const signoff = g.addNode({ url, signature: ["dlg"], state: "modal:Sign-off", kind: "modal", label: "modal: Sign-off", contentKey: "s" }).node;
  g.addEdge({ from: home.id, to: approve.id, kind: "click", element: { role: "button", name: "Approve", css: "#main > div > button:nth-of-type(1)" } });
  g.addEdge({ from: home.id, to: signoff.id, kind: "click", element: { role: "button", name: "Sign-off period", css: "#main > div > button:nth-of-type(2)" } });
  g.next();
  g.setStatus(home.id, "closed");
  g.annotate(ids[3], { artifacts: "nodes/x" });
  g.setStatus(ids[3], "closed");
  g.setStatus(ids[4], "closed");
  const dir = mkdtempSync(join(tmpdir(), "seemly-dedupe-"));
  save(g, dir);
  const templates = new Set(ids.map((id) => g.data.nodes[id].template)).size;

  const dry = O(["dedupe", "--dry-run", "--dir", dir]);
  assert.match(dry, new RegExp(`would collapse ${50 - templates} data-row node\\(s\\) into ${templates} sampled node`));
  assert.equal(Object.keys(open(dir, {}).data.nodes).length, 54, "a dry run changes nothing");

  assert.match(O(["dedupe", "--dir", dir]), /collapsed \d+ data-row node/);
  const back = open(dir, {});
  const drags = Object.values(back.data.nodes).filter((n) => n.label.startsWith("drag"));
  assert.equal(drags.length, templates, "one node per row template");
  const keep = back.data.nodes[ids[3]];
  assert.ok(keep, "the closed sample with artifacts is the one kept");
  assert.equal(keep.status, "closed");
  assert.equal(keep.label, "drag: <name>, <day> <date>, <time>-<time>");
  const edges = Object.values(back.data.edges);
  assert.ok(edges.every((e) => back.data.nodes[e.from] && back.data.nodes[e.to]), "no edge points at a removed node");
  assert.ok(edges.filter((e) => e.kind === "drag" && e.from === home.id).every((e) => drags.some((d) => d.id === e.to)), "every drag edge points at a kept node");
  assert.ok(edges.some((e) => e.to === menu.id && back.data.nodes[e.from].label.startsWith("drag")), "what only an exploded state opened is still reached");
  assert.ok(back.data.nodes[approve.id] && back.data.nodes[signoff.id], "two different confirms stay two nodes");
  assert.equal(back.data.meta.rowSamples[`${url}|drag|#main > table > tbody > tr > td > button`].tried, ROW_SAMPLE, "the group is seeded as sampled");
  assert.match(O(["dedupe", "--dir", dir]), /collapsed 0 data-row node/, "a second run finds nothing");
});

describe("walker on /rows/: 50 draggable, right-clickable rows", { skip, timeout: 600_000 }, () => {
  let site;
  let g;
  let inv;
  let home;
  before(async () => {
    site = await start();
    const dir = mkdtempSync(join(tmpdir(), "seemly-rows-walk-"));
    const profile = join(dir, "profile");
    const ex = await import("../explore.mjs");
    g = open(dir, {});
    Object.assign(g.data.meta, { target: `${site.base}/rows/`, origin: site.base, prefix: "/rows" });
    await ex.readEntry(g, `${site.base}/rows/`, { profile });
    save(g, dir);
    await ex.explore(g, dir, { profile, maxNodes: 30, widths: "off", log: () => {} });
    home = Object.values(g.data.nodes).find((n) => n.entry);
    inv = JSON.parse(readFileSync(join(dir, home.info.artifacts, "inventory.json"), "utf8"));
  });
  after(() => site?.server.close());

  const nodes = () => Object.values(g.data.nodes);
  const fired = (kind) => inv.interactions.filter((r) => r.kind === kind && !r.unfired);

  test("drags: at most K fired of 50, one state, titled without the row's data", () => {
    const rows = inv.interactions.filter((r) => r.kind === "drag");
    assert.equal(rows.length, 50, "every chip is a drag target");
    assert.ok(fired("drag").length <= ROW_SAMPLE, `${fired("drag").length} drags fired`);
    assert.equal(rows.filter((r) => r.unfired === "sampled-out").length, 50 - fired("drag").length);
    const states = nodes().filter((n) => n.label.startsWith("drag"));
    assert.ok(states.length >= 1 && states.length <= ROW_SAMPLE, `${states.length} drag state(s)`);
    for (const n of states) assert.equal(n.label, "drag: <name>, <day> <date>, <time>-<time>");
    for (const n of states) assert.doesNotMatch(n.state, /Doe|Rivera|\d+:\d+/, "identity carries no row data");
  });

  test("a drag that only moved a chip is closed same-as-parent, not walked again", () => {
    const [state] = nodes().filter((n) => n.label.startsWith("drag"));
    assert.equal(state.status, "closed");
    assert.equal(state.detail, "same-as-parent");
    assert.equal(state.info.sameAsParent, home.id);
    assert.ok(state.info.artifacts, "what it showed is recorded");
    assert.equal(Object.values(g.data.edges).filter((e) => e.from === state.id).length, 0, "nothing fired from it");
    assert.ok(Object.values(g.data.edges).some((e) => e.from === home.id && e.to === state.id && e.kind === "drag"), "the edge is recorded");
    assert.ok(fired("drag").every((r) => r.change), "and so is the change");
  });

  test("right-clicks: at most K per row template, one glance whatever person it names", () => {
    const chips = inv.interactions.filter((r) => r.kind === "contextmenu" && r.why === "listener");
    assert.equal(chips.length, 50);
    assert.ok(chips.filter((r) => !r.unfired).length <= ROW_SAMPLE);
    const glances = nodes().filter((n) => /Shift glance/.test(n.label));
    assert.equal(glances.length, 1, "one node for every person's glance");
    assert.equal(glances[0].label, "modal: Shift glance: <name>");
    assert.equal(glances[0].status, "closed", "the sample is walked");
  });

  test("two different confirms stay two nodes", () => {
    const to = (name) => Object.values(g.data.edges).filter((e) => e.from === home.id && e.element.name === name).map((e) => g.data.nodes[e.to]);
    const [a] = to("Approve");
    const [s] = to("Sign-off period");
    assert.ok(a && s);
    assert.notEqual(a.id, s.id);
    assert.match(a.label, /Approve timecard/);
    assert.match(s.label, /Sign-off/);
  });

  test("the walk stays small: no state per row", () => {
    assert.ok(nodes().length <= 8, `${nodes().length} nodes`);
    assert.equal(inv.invariant, "ok");
  });
});
