// Page pairing across URL schemes: a clone that does not mirror the reference's routes pairs
// nothing by view key; a pair map (exact keys, `:name` params, regexes on key, URL or route)
// pairs every page, the overlays inside pair as before, and an unmapped page pairs fuzzily
// and is flagged for a person to confirm.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { compare, keyFromRoute, mapView, pairNodes, readPairMap, toMarkdown } from "../compare.mjs";
import { report, writePairs } from "../verify.mjs";

function walk(origin, nodes) {
  const dir = mkdtempSync(join(tmpdir(), "pairmap-"));
  const out = {};
  for (const n of nodes) {
    out[n.id] = { kind: "page", state: "", status: "closed", signature: ["a", "b", "c"], ...n, url: origin + n.path, href: origin + n.path, label: n.label ?? n.path, info: { artifacts: `nodes/${n.id}` } };
    mkdirSync(join(dir, "nodes", n.id), { recursive: true });
    writeFileSync(join(dir, "nodes", n.id, "inventory.json"), JSON.stringify({ candidates: n.controls ?? [] }));
  }
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ nodes: out, edges: {}, templates: {}, modules: {}, meta: {} }));
  return dir;
}

const btn = (...names) => names.map((name) => ({ role: "button", name, outcome: "inert" }));

/** Reference: hash routes and legacy .do pages. Clone: plain REST-style paths. No key in common. */
function fixture() {
  const ref = walk("https://ref.test", [
    { id: "r_kiosk", path: "/metaui#/list/KioskConfiguration", controls: btn("New", "Edit") },
    { id: "r_kiosk_new", path: "/metaui#/list/KioskConfiguration", kind: "modal", state: "modal:New kiosk configuration", signature: ["f", "g"] },
    { id: "r_display", path: "/metaui#/list/DisplayProfile", controls: btn("New") },
    { id: "r_card", path: "/timekeeping#/timecard", controls: btn("Approve") },
    { id: "r_card_menu", path: "/timekeeping#/timecard", kind: "menu", state: "menu:Day actions", signature: ["m", "n"] },
    { id: "r_dv", path: "/ia#/dataView/123", controls: btn("Refresh") },
    { id: "r_legacy", path: "/wfc/applications/wtk/RequestSubtypeSetupList.do", controls: btn("Add") },
    { id: "r_plan", path: "/schedule#/planner", controls: btn("Generate") },
    { id: "r_profile", path: "/userProfile#/editProfile", signature: ["p", "q", "r", "s"], controls: btn("Language", "Time zone", "Cancel") },
  ]);
  const clone = walk("http://clone.test", [
    { id: "c_kiosk", path: "/administration/kiosk-configurations", controls: btn("New", "Edit") },
    { id: "c_kiosk_new", path: "/administration/kiosk-configurations", kind: "modal", state: "modal:New kiosk configuration", signature: ["f", "g"] },
    { id: "c_display", path: "/admin/DisplayProfile", controls: btn("New") },
    { id: "c_card", path: "/time/timecards", controls: btn("Approve") },
    { id: "c_card_menu", path: "/time/timecards", kind: "menu", state: "menu:Day actions", signature: ["m", "n"] },
    { id: "c_dv", path: "/reports/library/77", controls: btn("Refresh") },
    { id: "c_legacy", path: "/administration/RequestSubtype", controls: btn("Add") },
    { id: "c_plan", path: "/schedule/planner", controls: btn("Generate") },
    { id: "c_prefs", path: "/preferences", signature: ["p", "q", "r", "s"], controls: btn("Language", "Time zone", "Cancel") },
    { id: "c_other", path: "/elsewhere", signature: ["z"], controls: btn("Other") },
  ]);
  return { ref, clone };
}

// The format of a real pair-map.json ({ about, map }), plus params, regexes and a rules entry.
const MAP = {
  about: "reference view key -> clone view key",
  map: {
    "/metaui#/list/KioskConfiguration": "/administration/kiosk-configurations",
    "/metaui#/list/:entity": "/admin/:entity",
    "/timekeeping#/timecard": "/time/timecards",
    "/ia#/dataView/:id": "/reports/library/:id",
    "re:^/wfc/applications/\\w+/(\\w+)SetupList": "/administration/$1",
  },
  rules: [{ ref: "/schedule#/(?<view>\\w+)$", on: "url", clone: "/schedule/$<view>" }],
};

test("pair map: exact keys win over params; params, regex groups and named groups fill the clone side", () => {
  const pm = readPairMap(MAP);
  const at = (path) => mapView(pm, { url: `https://ref.test${path}` });
  assert.deepEqual(at("/metaui#/list/KioskConfiguration"), { clone: "/administration/kiosk-configurations", rule: "/metaui#/list/KioskConfiguration" });
  assert.equal(at("/metaui#/list/DisplayProfile").clone, "/admin/DisplayProfile");
  assert.equal(at("/ia#/dataView/987").clone, "/reports/library/:id");
  assert.equal(at("/wfc/applications/wtk/RequestSubtypeSetupList.do").clone, "/administration/RequestSubtype");
  assert.equal(at("/schedule#/planner").clone, "/schedule/planner");
  assert.equal(at("/nowhere"), null);
  assert.equal(keyFromRoute("/wfd/home"), "/wfd/home");
  assert.equal(keyFromRoute("http://x.test/a/42?tab=b&q=1"), "/a/:id?tab");
  assert.throws(() => readPairMap({ rules: [{ ref: "x", on: "title", clone: "/y" }] }), /on" is key, url or route/);
});

test("pairs across URL schemes: none without the map; with it every page pairs, overlays inside, one fuzzy pair flagged", () => {
  const { ref, clone } = fixture();
  const bare = pairNodes(ref, clone);
  assert.equal(bare.pairs.length, 0, "no view key in common: nothing pairs by key");
  assert.ok(bare.pages.every((p) => p.source === "none"));

  const doc = pairNodes(ref, clone, { pairMap: readPairMap(MAP) });
  const by = Object.fromEntries(doc.pairs.map((p) => [p.ref.id, p.clone.id]));
  assert.deepEqual(by, {
    r_kiosk: "c_kiosk", r_kiosk_new: "c_kiosk_new", r_display: "c_display", r_card: "c_card", r_card_menu: "c_card_menu",
    r_dv: "c_dv", r_legacy: "c_legacy", r_plan: "c_plan", r_profile: "c_prefs",
  });
  assert.deepEqual(doc.refOnly, []);
  assert.deepEqual(doc.cloneOnly.map((c) => c.clone.id), ["c_other"]);
  const src = Object.fromEntries(doc.pages.map((p) => [p.ref, p.source]));
  assert.equal(src["/userProfile#/editProfile"], "fuzzy");
  assert.equal(Object.values(src).filter((s) => s === "map").length, 6);
  assert.equal(doc.pairs.find((p) => p.ref.id === "r_kiosk_new").source, "map");
  assert.equal(doc.pairs.find((p) => p.ref.id === "r_profile").source, "fuzzy");

  writePairs(clone, doc);
  const md = report(clone);
  assert.match(md, /map 6 · key 0 · fuzzy 1 · none 0/);
  assert.match(md, /\| `\/userProfile#\/editProfile` \| `\/preferences` \| \*\*fuzzy pair: confirm\*\* \| score 1: confirm/);
  assert.match(md, /\| `\/metaui#\/list\/DisplayProfile` \| `\/admin\/DisplayProfile` \| pair map \| rule `\/metaui#\/list\/:entity` \|/);

  // `fuzzy: false` keeps an unmapped page unpaired.
  const strict = pairNodes(ref, clone, { pairMap: readPairMap({ ...MAP, fuzzy: false }) });
  assert.equal(strict.pages.find((p) => p.ref === "/userProfile#/editProfile").source, "none");
  assert.equal(strict.refOnly.map((p) => p.ref.id).join(), "r_profile");
});

test("compare: the walk diff follows the pair map and lists fuzzy pairs to confirm", () => {
  const { ref, clone } = fixture();
  assert.equal(compare(ref, clone).pagesMissing.length, 7);
  const r = compare(ref, clone, { pairMap: readPairMap(MAP) });
  assert.deepEqual(r.pagesMissing, []);
  assert.match(toMarkdown(r), /## Fuzzy pairs: confirm each[\s\S]*`\/userProfile#\/editProfile` \| `\/preferences`/);
});
