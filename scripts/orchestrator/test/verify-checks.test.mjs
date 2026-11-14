// Phase D's style, widths, websocket and overlay pieces without a browser, plus the check-record
// output folder: each proven to catch its defect and to pass the identical case.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeCheckRecord } from "../../lib/check-record.mjs";
import { cropImage, readStylesAllow, shiftRects, styleDiff, styleReason, unionRect, widthsDiff, widthsReason, withinCeiling, wsDiff, wsReason } from "../verify-checks.mjs";
import { CHECKS, nodeVerified, writeRecord } from "../verify.mjs";

const el = (role, name, style, nth = 0) => ({ role, name, nth, style: { fontFamily: "Arial", fontSize: "16px", fontWeight: "400", color: "rgb(0, 0, 0)", width: "120px", height: "32px", ...style } });

test("style: a font-weight difference on a matched element fails; identical manifests pass", () => {
  const ref = { elements: [el("heading", "Overview", { fontWeight: "700" }), el("button", "Save", {}), el("button", "Save", {}, 1)] };
  const clone = { elements: [el("heading", "Overview", { fontWeight: "500" }), el("button", "Save", {}), el("button", "Save", { color: "rgb(0, 0, 1)" }, 1)] };
  const d = styleDiff(ref, clone);
  assert.equal(d.matched, 3);
  assert.deepEqual(d.diffs.map((x) => `${x.element} ${x.prop}`), ['heading "Overview" fontWeight', 'button "Save" #2 color']);
  assert.match(styleReason(d), /heading "Overview" font-weight 700 vs 500/);
  assert.equal(styleDiff(ref, ref).passed, true);
  assert.equal(styleReason(styleDiff(ref, ref)), null);
});

test("style: ceilings and allow rows are declared, with a reason; one-sided elements are not style's to fail", () => {
  const ref = { elements: [el("button", "Save", { width: "120px" }), el("link", "Help", {})] };
  const clone = { elements: [el("button", "Save", { width: "121.5px" }), el("tab", "New", {})] };
  assert.equal(styleDiff(ref, clone).passed, false, "no ceiling: 1.5px is a difference");
  assert.equal(styleDiff(ref, clone, { allow: readStylesAllow({ ceilings: { width: 2 } }) }).passed, true);
  assert.equal(styleDiff(ref, clone, { allow: readStylesAllow({ allow: [{ element: "^button", prop: "width", max: 2, reason: "sub-pixel text width" }] }) }).passed, true);
  assert.throws(() => readStylesAllow({ allow: [{ element: "^button", prop: "width", max: 2 }] }), /no reason/);
  const d = styleDiff(ref, clone, { allow: readStylesAllow({ ceilings: { width: 2 } }) });
  assert.deepEqual([d.refOnly, d.cloneOnly], [['link "Help"'], ['tab "New"']]);
  assert.ok(withinCeiling("rgb(10, 10, 10)", "rgb(11, 10, 9)", 1));
  assert.ok(!withinCeiling("1px solid rgb(0, 0, 0)", "1px dashed rgb(0, 0, 0)", 5), "a keyword change is never within a ceiling");
});

test("widths: an item gone below a breakpoint on the clone fails at that width only; capture-width differences stay with structure", () => {
  const labels = (buttons) => ({ headings: ["h1 Overview"], nav: ["Home"], tabs: [], buttons, tableHeaders: [], fields: [], overflowX: false });
  const ref = { captured: 1440, widths: { 1024: labels(["Open filters", "Export"]), 1280: labels(["Open filters", "Export"]), 1440: labels(["Open filters", "Export"]) } };
  const clone = { 1024: labels(["Show filters"]), 1280: labels(["Show filters", "Export"]), 1440: labels(["Show filters", "Export"]) };
  const d = widthsDiff(ref, clone);
  assert.equal(d.compared, 3);
  assert.deepEqual(d.rows.map((r) => r.width), [1024]);
  assert.equal(widthsReason(d), "@1024: buttons missing Export");
  assert.deepEqual(d.atCapture.buttons.missing, ["Open filters"], "the label rename is recorded at the capture width, for structure");
  const same = { 1024: ref.widths[1024], 1280: ref.widths[1280], 1440: ref.widths[1440] };
  assert.equal(widthsDiff(ref, same).passed, true);
  assert.equal(widthsDiff(ref, clone, new Set(["buttons|Export"])).passed, true, "an allow row waives it");
  assert.match(widthsReason(widthsDiff(ref, { ...same, 1024: null })), /@1024: the overlay is gone/);
});

const shifts = { name: "/shifts/list", sent: { name: "/shifts/list", args: { week: "2026-W46" }, id: 1 }, received: { id: 1, data: { shifts: [{ id: 1, start: "09:00", end: "17:00" }], total: 1 } } };
const mirror = (res, q = "week=2026-W46") => ({ method: "GET", url: `http://c/api/shifts?${q}`, req: undefined, res });

test("ws: a read field the HTTP mirror drops fails; an unmapped call is 'ws call not mirrored'; a faithful mirror passes", () => {
  const map = { "/shifts/list": { method: "GET", path: "/api/shifts" } };
  const good = wsDiff([shifts], [mirror({ shifts: [{ id: 1, start: "09:00", end: "17:00" }], total: 1 })], map);
  assert.equal(good.passed, true, wsReason(good));
  const bad = wsDiff([shifts], [mirror({ shifts: [{ id: 1, start: "09:00" }], total: 1 })], map);
  assert.equal(bad.passed, false);
  assert.match(wsReason(bad), /WS \/shifts\/list -> GET \/api\/shifts: response fields missing shifts\[\]\.end/);
  const query = wsDiff([shifts], [mirror({ shifts: [{ id: 1, start: "09:00", end: "17:00" }], total: 1 }, "range=2026-W46")], map);
  assert.match(wsReason(query), /request fields missing week; request fields only on the clone range/);
  const unmapped = wsDiff([shifts], [mirror({})], {});
  assert.deepEqual(unmapped.notMirrored, ["/shifts/list"]);
  assert.match(wsReason(unmapped), /^ws call not mirrored: \/shifts\/list$/);
  const uncalled = wsDiff([shifts], [], map);
  assert.match(wsReason(uncalled), /mirror not called by the clone: WS \/shifts\/list -> GET \/api\/shifts/);
  const post = wsDiff([{ ...shifts, sent: ["/shifts/list", { filter: { week: "2026-W46" } }] }], [{ method: "POST", url: "http://c/api/shifts/search", req: { filter: { week: "x" } }, res: { shifts: [{ id: 1, start: "a", end: "b" }], total: 1 } }], { "/shifts/list": { method: "POST", path: "/api/shifts/search" } });
  assert.equal(post.passed, true, `an array frame's payload and a body mirror (${wsReason(post)})`);
});

test("overlay: crops to the union of both overlay boxes, masks follow the crop", () => {
  const img = { width: 10, height: 6, data: Buffer.alloc(10 * 6 * 4) };
  for (let i = 0; i < 60; i++) img.data.set([i, 0, 0, 255], i * 4);
  const box = unionRect({ x: 2, y: 1, width: 3, height: 2 }, { x: 4, y: 2, width: 3, height: 3 });
  assert.deepEqual(box, { x: 2, y: 1, width: 5, height: 4 });
  const c = cropImage(img, box);
  assert.deepEqual([c.width, c.height], [5, 4]);
  assert.equal(c.data[0], 12, "first pixel is (2,1)");
  assert.equal(c.data[(3 * 5 + 4) * 4], 46, "last pixel is (6,4)");
  assert.deepEqual(cropImage(img, { x: 8, y: 4, width: 5, height: 5 }).width, 2, "clipped to the image");
  assert.deepEqual(shiftRects([{ x: 5, y: 3, width: 1, height: 1 }], box), [{ x: 3, y: 2, width: 1, height: 1 }]);
  assert.equal(unionRect(null, box), box);
});

test("records: writeCheckRecord takes an output folder; a style skipped as 'ref style not captured' never verifies", () => {
  const dir = mkdtempSync(join(tmpdir(), "seemly-rec-"));
  const rec = writeCheckRecord("style", { ran: false, count: 0, status: "skipped", reason: "ref style not captured" }, join(dir, "n1"));
  assert.deepEqual(Object.keys(rec).sort(), ["at", "count", "ran", "reason", "status"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "n1", "style.json"), "utf8")).reason, "ref style not captured");
  assert.throws(() => writeCheckRecord("x", { ran: true, count: 1, status: "skipped" }, dir), /cannot have run/);
  for (const c of CHECKS.filter((c) => c !== "style")) writeRecord(join(dir, "verify", "n1"), c, { ran: true, count: 1, status: "pass" }, { ok: true });
  writeRecord(join(dir, "verify", "n1"), "style", { ran: false, count: 0, status: "skipped", reason: "ref style not captured: re-walk the node" });
  assert.ok(existsSync(join(dir, "verify", "n1", "pixels.detail.json")));
  const pass = { status: "pass" };
  const node = { id: "n1", verify: { ref: "r1", passed: true, ...Object.fromEntries(CHECKS.map((c) => [c, pass])) } };
  assert.ok(!nodeVerified(dir, node, "r1"), "the skipped style record keeps it unverified whatever the graph says");
  writeRecord(join(dir, "verify", "n1"), "style", { ran: true, count: 4, status: "pass" });
  assert.ok(nodeVerified(dir, node, "r1"));
  assert.deepEqual(CHECKS, ["pixels", "structure", "style", "human_eye", "widths", "api", "interactions", "writes"]);
});
