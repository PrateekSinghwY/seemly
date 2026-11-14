import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph, breadcrumbFromAria, tagScopes } from "../graph.mjs";
import { save } from "../store.mjs";
import { tree } from "../views.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const O = (args) => execFileSync(process.execPath, [join(here, "..", "run.mjs"), ...args], { encoding: "utf8" });

/** Home -> Settings (page) -> Account menu (overlay); Home -> Listings -> two detail pages of one template; one more detail page by URL only. */
function sample() {
  const g = Graph.create();
  const home = g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true, label: "Home" }).node;
  const settings = g.addNode({ url: "https://a.test/app/settings", signature: ["settings", "form"], label: "Settings" }).node;
  const menu = g.addNode({ url: "https://a.test/app/settings", state: "menu:Account", kind: "menu", signature: ["menu"], label: "menu: Account" }).node;
  const list = g.addNode({ url: "https://a.test/app/listings", signature: ["list", "table"], label: "Listings" }).node;
  const d1 = g.addNode({ url: "https://a.test/app/listings/1", signature: ["detail", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], label: "Unit 1" }).node;
  const d2 = g.addNode({ url: "https://a.test/app/listings/2", signature: ["detail", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"], label: "Unit 2", state: "x" }).node;
  const reports = g.addNode({ url: "https://a.test/app/reports?tab=week", signature: ["reports"], label: "Weekly" }).node;
  g.addEdge({ from: home.id, to: settings.id, kind: "navigation", element: { name: "Settings" } });
  g.addEdge({ from: settings.id, to: menu.id, kind: "click", element: { name: "Account" } });
  g.addEdge({ from: home.id, to: list.id, kind: "navigation", element: { name: "Listings" } });
  g.addEdge({ from: list.id, to: d1.id, kind: "click", element: { name: "Unit 1" } });
  g.addEdge({ from: list.id, to: d2.id, kind: "click", element: { name: "Unit 2" } });
  g.addEdge({ from: home.id, to: reports.id, kind: "navigation", element: { name: "Reports" } });
  g.annotate(list.id, { title: "Listings | App", heading: "All listings" });
  g.annotate(reports.id, { title: "Reports", heading: "Weekly report", breadcrumb: "Home > Analytics > Weekly" });
  return { g, home, settings, menu, list, d1, d2, reports };
}

test("scope: ordered rules on url, title, heading and breadcrumb; first match wins", () => {
  const { g, home, settings, list, reports, d1 } = sample();
  const counts = tagScopes(g, {
    rules: [
      { scope: "S02", url: "^/app/settings" },
      { scope: "S03", title: "^listings", heading: "all listings" },
      { scope: "S04", breadcrumb: "analytics" },
      { scope: "S99", url: "^/app/" , kind: "menu" },
    ],
  });
  assert.equal(g.node(settings.id).scope, "S02");
  assert.equal(g.node(list.id).scope, "S03", "title and heading must both match");
  assert.equal(g.node(reports.id).scope, "S04", "breadcrumb rule");
  assert.equal(g.node(home.id).scope, null, "nothing matched: unscoped");
  assert.equal(g.node(d1.id).scope, null, "a detail page shares no template with a tagged node");
  assert.equal(counts.unscoped, 3);
  assert.equal(g.data.meta.scopes.counts.S02, 2, "the settings menu shares the page's URL, so rule 1 tags it before the S99 rule");
  assert.equal(g.data.meta.scopes.counts.S99, undefined);
});

test("scope: untagged overlays inherit their parent's scope, template members their peers'", () => {
  const { g, menu, d1, d2 } = sample();
  tagScopes(g, { rules: [{ scope: "S02", url: "^/app/settings$", kind: "page" }, { scope: "S03", url: "^/app/listings/1$" }] });
  assert.equal(g.node(menu.id).scope, "S02");
  assert.equal(g.node(menu.id).scopeBy, "parent");
  assert.equal(g.node(d1.id).template, g.node(d2.id).template);
  assert.equal(g.node(d2.id).scope, "S03");
  assert.equal(g.node(d2.id).scopeBy, "template");
  tagScopes(g, { inherit: false, rules: [{ scope: "S02", url: "^/app/settings$", kind: "page" }] });
  assert.equal(g.node(menu.id).scope, null, "inherit: false turns propagation off");
});

test("scope: a template rule, stats per scope, and the scoped tree", () => {
  const { g, d1, home } = sample();
  tagScopes(g, { rules: [{ scope: "S05", template: g.node(d1.id).template }] });
  const s = g.stats("S05");
  assert.equal(s.nodes, 2);
  assert.equal(s.frontier, 2);
  assert.equal(g.stats("unscoped").nodes, 5);
  assert.equal(g.stats().nodes, 7);
  const t = tree(g, { scope: "S05" });
  assert.match(t, /# Surface tree: S05/);
  assert.match(t, /Unit 1/);
  assert.match(t, /\*\*Home\*\*.*\(via, other scope\)/, "the route to the scope is drawn, marked");
  assert.doesNotMatch(t, /Settings/, "branches without the scope are pruned");
  assert.ok(home);
});

test("breadcrumb from a saved AX tree", () => {
  const aria = `- banner:\n  - navigation "Breadcrumb":\n    - list:\n      - listitem:\n        - link "Home":\n          - /url: /\n      - listitem:\n        - link "Timecards":\n      - listitem: Approve\n- main:\n  - heading "Approve" [level=1]`;
  assert.equal(breadcrumbFromAria(aria), "Home > Timecards > Approve");
  assert.equal(breadcrumbFromAria("- main"), "");
});

test("O scope / status --scope / tree --scope on a saved graph", () => {
  const { g } = sample();
  const dir = mkdtempSync(join(tmpdir(), "scope-"));
  save(g, dir);
  const map = join(dir, "scope.json");
  writeFileSync(map, JSON.stringify({ rules: [{ scope: "S02", url: "^/app/settings" }, { scope: "S03", url: "^/app/listings" }] }));
  const out = O(["scope", "--dir", dir, "--map", map]);
  assert.match(out, /S02\s+2/);
  assert.match(out, /S03\s+3/);
  assert.match(out, /unscoped\s+2/);
  const saved = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
  assert.equal(Object.values(saved.nodes).filter((n) => n.scope === "S03").length, 3);
  const st = O(["status", "--dir", dir, "--scope", "S03"]);
  assert.match(st, /SCOPE\s+S03/);
  assert.match(st, /GRAPH\s+3 nodes/);
  assert.match(O(["status", "--dir", dir]), /SCOPES\s+.*S02 2/);
  O(["tree", "--dir", dir, "--scope", "S02"]);
  const t = readFileSync(join(dir, "tree-S02.md"), "utf8");
  assert.match(t, /menu: Account/);
  assert.doesNotMatch(t, /Unit 1/);
});
