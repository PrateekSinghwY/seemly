// Phase D pieces without a browser: PNG codec and pixel diff, the AX-tree diff, the API diff,
// node pairing, and the counts and report read back from pairs.json plus check records.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pairNodes } from "../compare.mjs";
import { CHECKS, apiDiff, decodePng, diffAria, encodePng, nodeVerified, parseAria, pixelDiff, report, scopePairs, verifyCounts, writePairs, writeRecord } from "../verify.mjs";

function image(width, height, fill) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...fill, 255], i * 4);
  return { width, height, data };
}
const paint = (img, x0, y0, w, h, rgb) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) img.data.set([...rgb, 255], (y * img.width + x) * 4);
};

test("png: encode then decode is lossless", () => {
  const a = image(7, 5, [10, 200, 30]);
  paint(a, 2, 1, 3, 2, [250, 0, 120]);
  const b = decodePng(encodePng(a));
  assert.equal(b.width, 7);
  assert.equal(b.height, 5);
  assert.ok(b.data.equals(a.data));
});

test("pixels: differences counted per region; masks hide synthetic data; a size change counts", () => {
  const ref = image(100, 60, [255, 255, 255]);
  const clone = image(100, 60, [255, 255, 255]);
  paint(ref, 10, 10, 20, 10, [30, 170, 120]);
  paint(clone, 10, 10, 20, 10, [200, 50, 50]); // the planted region
  paint(clone, 60, 40, 30, 8, [0, 0, 0]); // a name that differs on purpose
  const regions = [{ name: 'complementary "Status"', x: 5, y: 5, width: 30, height: 20 }, { name: "main", x: 0, y: 0, width: 100, height: 60 }];
  const masked = pixelDiff(ref, clone, { masks: [{ x: 58, y: 38, width: 34, height: 12 }], regions });
  assert.equal(masked.differing, 200);
  assert.deepEqual(masked.regions.map((r) => r.name).sort(), ['complementary "Status"', "main"]);
  assert.equal(masked.regions.find((r) => r.name.startsWith("complementary")).differing, 200);
  assert.deepEqual(masked.box, { x: 10, y: 10, width: 20, height: 10 });
  const open = pixelDiff(ref, clone, { regions });
  assert.equal(open.differing, 440, "unmasked, the name counts too");
  const same = pixelDiff(ref, ref);
  assert.equal(same.differing, 0);
  const taller = pixelDiff(ref, image(100, 62, [255, 255, 255]), { masks: [{ x: 0, y: 0, width: 50, height: 30 }] });
  assert.equal(taller.sizes.clone[1], 62);
  assert.ok(taller.differing >= 200, "rows only one side has are differences");
  const hidpi = pixelDiff(image(4, 4, [0, 0, 0]), image(4, 4, [255, 255, 255]), { dpr: 2, masks: [{ x: 0, y: 0, width: 1, height: 1 }] });
  assert.equal(hidpi.differing, 12, "a mask in CSS px covers dpr x dpr device pixels");
});

const REF_ARIA = `- banner:
  - navigation "Main":
    - link "Home":
      - /url: /app/
    - link "Reports"
- main:
  - heading "Overview" [level=1]
  - paragraph: Alex Doe
  - paragraph: "Total: 42"
  - button "Open filters"
  - complementary "Status"
  - table:
    - rowgroup:
      - row "Region Count":
        - columnheader "Region"
        - columnheader "Count"
      - row "North 12":
        - cell "North"
        - cell "12"
        - button "Edit North"
  - 'button "Tab: 3 open"'
  - checkbox "Remember" [checked]`;

test("structure: roles, names, states and order from saved AX trees; data rows ignored", () => {
  const ref = parseAria(REF_ARIA);
  assert.ok(ref.includes('heading "Overview" [level=1]'));
  assert.ok(ref.includes('columnheader "Region"'));
  assert.ok(!ref.some((e) => /North/.test(e)), "cells and row controls are data");
  assert.ok(ref.includes('button "Tab: # open"'), "quoted lines unwrapped, digits are data");
  assert.ok(ref.includes('checkbox "Remember" [checked]'));
  const clone = parseAria(REF_ARIA.replace("Open filters", "Show filters").replace("Alex Doe", "Sam Rivera").replace('"North 12"', '"South 9"').replace("[checked]", ""));
  const d = diffAria(ref, clone);
  assert.deepEqual(d.missing.sort(), ['button "Open filters"', 'checkbox "Remember" [checked]']);
  assert.deepEqual(d.extra.sort(), ['button "Show filters"', 'checkbox "Remember"']);
  assert.equal(diffAria(ref, parseAria(REF_ARIA)).missing.length, 0);
  const swapped = parseAria(REF_ARIA.replace('link "Home"', 'link "TMP"').replace('link "Reports"', 'link "Home"').replace('link "TMP"', 'link "Reports"'));
  assert.equal(diffAria(ref, swapped).order, true);
  const ignored = diffAria(parseAria(REF_ARIA, { ignore: ["filters$"] }), parseAria(REF_ARIA.replace("Open filters", "Show filters"), { ignore: ["filters$"] }));
  assert.equal(ignored.missing.length + ignored.extra.length, 0, "ignore patterns blank a name on both sides");
});

test("api: missing operations, query keys, request and response fields; prefixes stripped", () => {
  const ref = [
    { method: "GET", url: "https://ref.test/svc/summary?period=week", res: { total: 42, label: "Week" } },
    { method: "POST", url: "https://ref.test/svc/people/multi_read", req: { where: { ids: [1] }, select: ["name"] }, res: { items: [{ id: 1, name: "x" }] } },
    { method: "GET", url: "https://ref.test/svc/flags", res: {} },
  ];
  const clone = [
    { method: "GET", url: "http://clone.test/api/svc/summary?range=week", res: { total: 7, label: "Week" } },
    { method: "POST", url: "http://clone.test/api/svc/people/multi_read", req: { where: { ids: [3] } }, res: { items: [{ id: 3, name: "y", extra: 1 }] } },
    { method: "GET", url: "http://clone.test/api/svc/own", res: {} },
  ];
  const d = apiDiff(ref, clone, { clonePrefix: "/api" });
  assert.deepEqual(d.missing, ["GET /svc/flags"]);
  const sum = d.drift.find((x) => x.key === "GET /svc/summary");
  assert.deepEqual(sum.queryMissing, ["period"]);
  assert.deepEqual(sum.queryExtra, ["range"]);
  const mr = d.drift.find((x) => x.key === "POST /svc/people/multi_read");
  assert.deepEqual(mr.reqMissing, ["select"]);
  assert.deepEqual(mr.resExtra, ["items[].extra"]);
  assert.deepEqual(d.extraOps, ["GET /svc/own"]);
  assert.equal(d.passed, false);
  assert.equal(apiDiff(ref, ref).passed, true);
  assert.equal(apiDiff(ref, clone, { clonePrefix: "/api", ignore: ["flags$", "summary$", "multi_read$"] }).passed, true);
});

/** A walk on disk with nodes as given (signature, kind, state, status, controls). */
function walk(origin, nodes, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pairs-"));
  const out = {};
  for (const n of nodes) {
    out[n.id] = { kind: "page", state: "", status: "closed", signature: ["a", "b", "c"], ...n, url: origin + n.path, href: origin + n.path, label: n.label ?? n.path, info: { artifacts: `nodes/${n.id}` } };
    mkdirSync(join(dir, "nodes", n.id), { recursive: true });
    writeFileSync(join(dir, "nodes", n.id, "inventory.json"), JSON.stringify({ candidates: n.controls ?? [] }));
  }
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ nodes: out, edges: {}, templates: {}, modules: {}, meta: {}, ...extra }));
  return dir;
}

function pairFixture() {
  const ref = walk("https://ref.test", [
    { id: "r_home", path: "/app/", scope: "S01", controls: [{ role: "button", name: "Open filters" }] },
    { id: "r_modal", path: "/app/", kind: "modal", state: "modal:Filters", signature: ["d", "e"], scope: "S01" },
    { id: "r_modal2", path: "/app/", kind: "modal", state: "modal:Export", signature: ["x", "y"], scope: "S01" },
    { id: "r_unit7", path: "/app/units/7", scope: "S02" },
    { id: "r_unit8", path: "/app/units/8", signature: ["a", "b", "z"], scope: "S02" },
    { id: "r_help", path: "/help", status: "gap", detail: undefined, signature: ["out-of-scope"], scope: "S01" },
    { id: "r_big", path: "/app/units/9", status: "bounded", bound: "path family over 30 members", scope: "S02" },
  ]);
  const clone = walk("http://clone.test", [
    { id: "c_home", path: "/app/", controls: [{ role: "button", name: "Show filters" }] },
    { id: "c_modal", path: "/app/", kind: "modal", state: "modal:Filters", signature: ["d", "q"] },
    { id: "c_unit", path: "/app/units/3" },
    { id: "c_extra", path: "/app/new" },
  ]);
  return { ref, clone };
}

test("pairs: same view key and kind, best structure + labels + title, one to one; leftovers with reasons", () => {
  const { ref, clone } = pairFixture();
  const doc = pairNodes(ref, clone);
  const by = Object.fromEntries(doc.pairs.map((p) => [p.ref.id, p.clone.id]));
  assert.deepEqual(by, { r_home: "c_home", r_modal: "c_modal", r_unit7: "c_unit" }, "the exact skeleton wins the one detail clone node");
  const only = Object.fromEntries(doc.refOnly.map((p) => [p.ref.id, p.reason]));
  assert.equal(only.r_modal2, "not on the clone", "an overlay with another title and skeleton never pairs");
  assert.equal(only.r_unit8, "not on the clone");
  assert.equal(only.r_help, "gap: out of scope");
  assert.match(only.r_big, /^bounded: path family over 30/);
  assert.deepEqual(doc.cloneOnly.map((c) => c.clone.id), ["c_extra"]);
  const s1 = scopePairs(doc, "S01");
  assert.deepEqual(s1.pairs.map((p) => p.ref.id).sort(), ["r_home", "r_modal"]);
  assert.deepEqual(s1.refOnly.map((p) => p.ref.id).sort(), ["r_help", "r_modal2"]);
  assert.deepEqual(s1.cloneOnly, [], "an untagged clone node outside the scope's views is not the scope's");
});

test("counts and report: verified only when every applicable check passed with its record on disk", () => {
  const { ref, clone } = pairFixture();
  const doc = pairNodes(ref, clone);
  writePairs(clone, doc);
  const graphPath = join(clone, "graph.json");
  const cg = JSON.parse(readFileSync(graphPath, "utf8"));
  const pass = { status: "pass", reason: null };
  const na = { status: "n/a", reason: "not applicable: no write edges" };
  cg.nodes.c_home.verify = { ref: "r_home", pixels: pass, structure: { status: "fail", reason: 'missing on the clone: button "Open filters"' }, style: pass, human_eye: pass, widths: pass, api: pass, interactions: pass, writes: na, passed: false };
  cg.nodes.c_modal.verify = { ref: "r_modal", pixels: pass, structure: pass, style: pass, human_eye: pass, widths: pass, api: pass, interactions: pass, writes: na, passed: true };
  cg.nodes.c_unit.verify = { ref: "r_unit7", pixels: pass, structure: pass, style: pass, human_eye: pass, widths: pass, api: pass, interactions: pass, writes: na, passed: true };
  writeFileSync(graphPath, JSON.stringify(cg));
  for (const id of ["c_modal", "c_unit"]) {
    const dir = join(clone, "verify", id);
    for (const c of CHECKS) writeRecord(dir, c, c === "writes" ? { ran: false, count: 0, status: "skipped", reason: "not applicable: no write edges" } : { ran: true, count: 1, status: "pass" });
  }
  // c_unit's graph says passed, but one record on disk failed: not verified.
  writeRecord(join(clone, "verify", "c_unit"), "pixels", { ran: true, count: 9, status: "fail", reason: "9 differing pixel(s)" });
  const cgr = JSON.parse(readFileSync(graphPath, "utf8"));
  assert.ok(nodeVerified(clone, cgr.nodes.c_modal, "r_modal"));
  assert.ok(!nodeVerified(clone, cgr.nodes.c_unit, "r_unit7"), "the record wins over the graph");
  assert.ok(!nodeVerified(clone, cgr.nodes.c_modal, "r_home"), "verified against another reference node does not count");
  const c = verifyCounts(clone);
  assert.deepEqual([c.verified, c.built, c.refOnly, c.refOnlyReasoned], [1, 3, 4, 2]);
  const s2 = verifyCounts(clone, "S02");
  assert.deepEqual([s2.verified, s2.built, s2.refOnly], [0, 1, 2]);
  const md = report(clone, "S01");
  assert.match(md, /# Phase D report: S01/);
  assert.match(md, /verified 1 \/ built 2 \/ ref-only 2/);
  assert.match(md, /\| \/app\/ `r_home` \| \/app\/ `c_home` \| pass \| \*\*FAIL\*\* \| pass \| pass \| pass \| pass \| pass \| n\/a \| no \| structure: missing on the clone: button "Open filters" \|/);
  assert.match(md, /`r_help` \| page \| `\/help` \| gap \| gap: out of scope \|/);
  assert.match(md, /`r_modal2` .*not on the clone/);
});
