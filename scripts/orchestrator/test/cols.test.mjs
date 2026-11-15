// Repeated click triggers do not explode the graph (SKILL.md section 4, "Repeated click
// triggers"). A dataview grid with a ▾ per column header once minted one overlay per column and
// per dataview page ("overlay: .grid1794721638366 . · Hide column ..."), each walked in full at
// about 28 s; 260 of them filled one queue. Proven here:
//   unit     generated class names and ids leave labels; the click groups of a header row split
//            text columns from number columns by their cell's type token; the sampler gives back a
//            sample that never fired and fires a group in full once it changes the page in place
//   dedupe   `O dedupe` collapses an exploded graph (a column menu per column per page) into one
//            node per item set, labels without generated ids, and seeds the click sampler
//   /cols/   a walk of a 30-column grid opens at most K menus per item set (text, number), the
//            rest `sampled-out` with their group id; labels carry no generated id or column name
// The walker part needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROW_SAMPLE, clickGroups, maskItem, normaliseData, rowSampler, stripGenerated } from "../bound.mjs";
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

const GENERATED = /\d{6,}|grid\d|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}/i;

test("generated ids: class names and ids an app mints per load leave labels and content keys", () => {
  assert.equal(stripGenerated("overlay: .grid1794721638366 . · Hide column"), "overlay: Hide column");
  assert.equal(stripGenerated(".grid1794591415677 . · Sort ascending Sort"), "Sort ascending Sort");
  assert.equal(stripGenerated("menu: #menu-a3f9c2e1b7 Tools"), "menu: Tools");
  assert.equal(stripGenerated("Load 25 more"), "Load 25 more", "a short number is not an id");
  assert.equal(stripGenerated("Approve timecard"), "Approve timecard");
  assert.equal(normaliseData("row a3f9c2e1b7d4 open"), "row <id> open", "a hex id in a content key reads <id>");
  assert.equal(maskItem("Employee id: Sort by Employee id · Hide column", "Employee id"), "<item>: Sort by <item> · Hide column");
  assert.equal(maskItem("Hide column", "id"), "Hide column", "whole words only");
});

test("click groups: a header row of 30 ▾ triggers, text and number columns apart", () => {
  const cands = Array.from({ length: 30 }, (_, i) => ({
    role: "button",
    name: `Col${i} name column, more actions`,
    css: `main > table > thead > tr > th:nth-of-type(${i + 1}) > button`,
    hint: ["mb", "col", `col-${i}`.replace(/\d+/g, "#"), ...(i >= 20 ? ["num"] : []), ...(i === 3 ? ["sorted"] : [])],
  }));
  cands.push({ role: "tab", name: "One", css: "nav > button:nth-of-type(1)" }, { role: "tab", name: "Two", css: "nav > button:nth-of-type(2)" }, { role: "tab", name: "Three", css: "nav > button:nth-of-type(3)" });
  const m = clickGroups(cands);
  assert.equal(m.size, 30, "tabs are never sampled; the 30 triggers are");
  const ids = new Set([...m.values()].map((x) => x.id));
  assert.equal(ids.size, 2, "two sub-groups: text columns and number columns (a sort mark on one column is its data)");
  assert.equal(m.get(cands[0].css).hint, "");
  assert.equal(m.get(cands[25].css).hint, "num");
  assert.equal(m.get(cands[0].css).text, "Col0", "the part of its name the members do not share, whole words");
  const onlyNum = clickGroups(cands.slice(20, 30));
  assert.equal(onlyNum.get(cands[25].css).hint, "num", "a page of number columns only keys the same as the number columns of a mixed page");
});

test("click sampler: a sample that never fired is given back; a group that changes the page in place fires in full", () => {
  const s = rowSampler({});
  assert.ok(s.take("k"));
  s.release("k");
  assert.ok(s.take("k") && s.take("k"));
  s.lead("k", "t1");
  s.lead("k", "t1");
  assert.equal(s.take("k"), false, "K samples with one lead: the rest are sampled out");
  const t = rowSampler({});
  t.take("tabs");
  t.exempt("tabs");
  let n = 0;
  for (let i = 0; i < 40; i++) if (t.take("tabs")) n++;
  assert.equal(n, 40);
});

test("dedupe: a column menu per column per dataview page collapses to one node per item set", () => {
  const g = Graph.create();
  const pages = [];
  const menus = { text: [], num: [] };
  let seq = 1794591415677;
  for (let p = 0; p < 10; p++) {
    const url = `https://a.test/dv/${100 + p}`;
    const page = g.addNode({ url, signature: ["pg", "grid"], entry: p === 0, label: `Dataview ${p}` }).node;
    pages.push(page);
    for (const kind of ["text", "num"]) {
      const items = kind === "num" ? "Sort ascending Sort descending Hide column Sum Avg" : "Sort ascending Sort descending Hide column";
      const n = g.addNode({ url, signature: ["mn", "mi"], state: `overlay:.grid${seq} .`, kind: "overlay", label: `overlay: .grid${seq++} . · ${items}`, contentKey: kind === "num" ? "c0ffee01" : "c0ffee00" }).node;
      menus[kind].push(n.id);
    }
    for (let i = 0; i < 30; i++) {
      const to = menus[i >= 20 ? "num" : "text"][p];
      const element = { role: "button", name: `Col${i} column, more actions`, css: `#grid > table > thead > tr > th:nth-of-type(${i + 1}) > button` };
      g.addEdge({ from: page.id, to, kind: "click", element });
      if (i % 7 === 0) g.addEdge({ from: page.id, to, kind: "key", element: { ...element, key: "Enter" } });
    }
    if (p) g.addEdge({ from: pages[0].id, to: page.id, kind: "navigation", element: { role: "link", name: `Dataview ${p}`, css: `nav > a:nth-of-type(${p})` } });
  }
  // a walked menu: an item that opened a dialog of its own
  const grp = g.addNode({ url: pages[4].url, signature: ["dlg"], state: "modal:Group by", kind: "modal", label: "modal: Group by", contentKey: "ab12" }).node;
  g.addEdge({ from: menus.text[4], to: grp.id, kind: "click", element: { role: "menuitem", name: "Group by this column", css: "#m > div > button:nth-of-type(4)" } });
  // a lone filter overlay per page: one trigger, not a repeat group, never collapsed
  const filters = pages.slice(0, 3).map((pg, i) => {
    const f = g.addNode({ url: pg.url, signature: ["flt"], state: "overlay:Filter", kind: "overlay", label: "overlay: Filter", contentKey: "f1" }).node;
    g.addEdge({ from: pg.id, to: f.id, kind: "click", element: { role: "button", name: "Filter", css: "#bar > button" } });
    return f.id;
  });
  g.next();
  g.setStatus(pages[0].id, "closed");
  g.annotate(menus.text[3], { artifacts: "nodes/x" });
  g.setStatus(menus.text[3], "closed");
  const dir = mkdtempSync(join(tmpdir(), "seemly-cols-dedupe-"));
  save(g, dir);
  const before = Object.keys(g.data.nodes).length;

  const dry = O(["dedupe", "--dry-run", "--dir", dir]);
  assert.match(dry, /would collapse 18 click-trigger overlay node\(s\) into 2 sampled node\(s\); 20 label\(s\) would lose a generated id/);
  assert.equal(Object.keys(open(dir, {}).data.nodes).length, before, "a dry run changes nothing");

  assert.match(O(["dedupe", "--dir", dir]), /collapsed 18 click-trigger overlay node/);
  const back = open(dir, {});
  const N = back.data.nodes;
  const overlays = Object.values(N).filter((n) => /Sort ascending/.test(n.label));
  assert.equal(overlays.length, 2, "one text-column menu and one number-column menu");
  assert.ok(N[menus.text[3]], "the closed sample with artifacts is the one kept");
  assert.equal(N[menus.text[3]].label, "overlay: Sort ascending Sort descending Hide column");
  assert.ok(Object.values(N).every((n) => !GENERATED.test(n.label)), "no label keeps a generated id");
  const edges = Object.values(back.data.edges);
  assert.ok(edges.every((e) => N[e.from] && N[e.to]), "no edge points at a removed node");
  assert.ok(edges.some((e) => e.to === grp.id && overlays.some((o) => o.id === e.from)), "what only a removed menu opened is still reached");
  assert.ok(filters.every((id) => N[id]), "a lone trigger's overlays are not this pass's");
  const seeded = Object.entries(back.data.meta.rowSamples).filter(([k]) => k.includes("|click|"));
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0][1].tried, ROW_SAMPLE, "the trigger group is seeded as sampled");
  assert.match(O(["dedupe", "--dir", dir]), /collapsed 0 click-trigger overlay node/, "a second run finds nothing");
});

describe("walker on /cols/: 30 column headers, each with a ▾ menu", { skip, timeout: 600_000 }, () => {
  let site;
  let g;
  let inv;
  before(async () => {
    site = await start();
    const dir = mkdtempSync(join(tmpdir(), "seemly-cols-walk-"));
    const profile = join(dir, "profile");
    const ex = await import("../explore.mjs");
    g = open(dir, {});
    Object.assign(g.data.meta, { target: `${site.base}/cols/`, origin: site.base, prefix: "/cols" });
    await ex.readEntry(g, `${site.base}/cols/`, { profile });
    save(g, dir);
    await ex.explore(g, dir, { profile, maxNodes: 12, widths: "off", interactions: false, log: () => {} });
    const home = Object.values(g.data.nodes).find((n) => n.entry);
    inv = JSON.parse(readFileSync(join(dir, home.info.artifacts, "inventory.json"), "utf8"));
  });
  after(() => site?.server.close());

  const triggers = () => inv.candidates.filter((r) => /column, more actions$/.test(r.name));
  const menus = () => Object.values(g.data.nodes).filter((n) => n.kind === "menu");

  test("at most K menus opened per item set, and the number-column set is reached", () => {
    const all = triggers();
    assert.equal(all.length, 30);
    const fired = all.filter((r) => !r.unfired);
    const text = fired.filter((r) => /^(Employee|Department|Job|Location|Manager|Pay rule|Status|Shift type|Team|Cost center|Union|Region|Badge|Home site|Work rule|Leave case|Reason|Category|Comment)/.test(r.name));
    assert.ok(text.length >= 1 && text.length <= ROW_SAMPLE, `${text.length} text-column menus opened`);
    const num = fired.length - text.length;
    assert.ok(num >= 1 && num <= ROW_SAMPLE, `${num} number-column menus opened`);
    const out = all.filter((r) => r.unfired === "sampled-out");
    assert.equal(out.length, 30 - fired.length, "the rest are sampled out");
    assert.ok(out.every((r) => /^[0-9a-f]{8}$/.test(r.group)), "each with its group id");
    assert.equal(new Set(out.map((r) => r.group)).size, 2);
  });

  test("two menu nodes, one per item set; the two samples of a set key alike", () => {
    assert.equal(menus().length, 2, menus().map((n) => n.label).join(" | "));
    assert.equal(new Set(menus().map((n) => n.contentKey)).size, 2);
  });

  test("labels carry no generated id and no column name", () => {
    for (const n of menus()) {
      assert.doesNotMatch(n.label, GENERATED, n.label);
      assert.doesNotMatch(n.label, /Employee|Actual hours|Department|Scheduled/, n.label);
      assert.doesNotMatch(n.state, /\d{6,}|Employee|hours/, "identity carries no column text");
    }
  });
});
