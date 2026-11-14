// Every interaction kind as a first-class edge, and a scope-driven walk of hash routes:
//   units     key names, synthetic values per constraint, fixture files, the interaction
//             invariant, edge-level comparison, route fragments in node identity and families,
//             entry files, scope priority
//   /kit/     the walker records a right-click, a double-click, a drag, a documented shortcut,
//             keyboard activation, empty / valid / invalid form submits and uploads, plus the
//             Tab order, with every row accounted for
//   /spa/     hash routes are separate nodes walked before an out-of-scope area, which is closed
//             shallowly; entries come from a file; an in-scope family is never bounded
// The browser tests need Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { admit } from "../bound.mjs";
import { edgeDiff, viewKey } from "../compare.mjs";
import { Graph, canonicalUrl } from "../graph.mjs";
import { fixtureFile, focusDiff, interactionInvariant, invalidValues, patternSample, pwKeys, readShortcuts, syntheticValue } from "../interactions.mjs";
import { start } from "./fixture/site.mjs";

const repo = process.env.RL_REPO || process.cwd();
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

// ---------- units ----------

test("keys: shortcuts as keyboards.json writes them become Playwright presses", () => {
  assert.deepEqual(pwKeys("alt+m"), ["Alt+m"]);
  assert.deepEqual(pwKeys("mod+k"), ["ControlOrMeta+k"]);
  assert.deepEqual(pwKeys("⌘K"), ["Meta+k"]);
  assert.deepEqual(pwKeys("Shift+?"), ["Shift+?"]);
  assert.deepEqual(pwKeys("g i"), ["g", "i"], "a sequence is pressed key by key");
  assert.deepEqual(pwKeys("esc"), ["Escape"]);
  assert.deepEqual(readShortcuts({ shortcuts: [{ keys: "alt+m", action: "menu", implemented: false, reason: "out of scope" }, { action: "no keys" }] }), [{ keys: "alt+m", action: "menu", implemented: false, reason: "out of scope" }]);
});

test("forms: a valid value per type and constraint, and one invalid value per constraint", () => {
  const badge = { name: "Badge", type: "text", pattern: "[A-Z]{2}-\\d{4}", required: false };
  const v = syntheticValue(badge).value;
  assert.match(v, /^[A-Z]{2}-\d{4}$/, `pattern sample ${v}`);
  assert.equal(patternSample("\\d{3}-[a-z]+"), "000-a");
  assert.equal(syntheticValue({ name: "Email", type: "email" }).value, "alex.doe@example.com", "reserved documentation domain");
  assert.equal(syntheticValue({ name: "Hours", type: "number", min: "4", max: "8" }).value, "4");
  assert.deepEqual(syntheticValue({ name: "Unit", type: "select", options: [{ value: "", label: "Pick" }, { value: "d", label: "Days" }] }), { how: "select", value: "d" });
  assert.equal(syntheticValue({ name: "Note", type: "text", minLength: 20 }).value.length, 20);
  assert.deepEqual(invalidValues({ name: "Code", type: "text", required: true }).map((x) => x.constraint), ["required"]);
  assert.deepEqual(invalidValues(badge).map((x) => [x.constraint, x.value]), [["pattern", "!!"]]);
  assert.deepEqual(invalidValues({ name: "Hours", type: "number", min: "4", max: "8" }).map((x) => x.value), ["3", "9"]);
  assert.deepEqual(invalidValues({ name: "Email", type: "email", required: true }).map((x) => x.constraint), ["required", "type"]);
});

test("uploads: a tiny accepted fixture and a rejected one, per accept list", () => {
  assert.equal(fixtureFile([".csv", "text/csv"]).name, "sample.csv");
  assert.notEqual(fixtureFile([".csv"], false).name.endsWith(".csv"), true);
  assert.equal(fixtureFile(["image/*"]).mimeType, "image/png");
  assert.equal(fixtureFile([], false), null, "accepts anything: nothing to reject");
});

test("invariant: every interaction row is an edge, a fired result or a known reason", () => {
  const known = (r) => ["inherited", "sampled-out"].includes(r);
  const ok = [
    { kind: "contextmenu", role: "gridcell", name: "A", outcome: "overlay", to: ["n_1"] },
    { kind: "dblclick", role: "gridcell", name: "A", outcome: "inert", to: [] },
    { kind: "key", role: "shortcut", name: "alt+m", outcome: "inherited", unfired: "inherited", to: [] },
    { kind: "upload", role: "button", name: "File", outcome: "upload-needs-writes", unfired: "upload-needs-writes", to: [] },
    { kind: "submit", role: "button", name: "Go", outcome: "write-attempt", to: [] },
  ];
  assert.deepEqual(interactionInvariant(ok, known), []);
  assert.equal(interactionInvariant([{ kind: "drag", role: "slider", name: "S", outcome: "state", to: [] }], known).length, 1, "an edge outcome needs its edge");
  assert.equal(interactionInvariant([{ kind: "drag", role: "slider", name: "S", outcome: "x", unfired: "felt like it", to: [] }], known).length, 1, "an unknown reason");
  assert.equal(interactionInvariant([{ kind: "wiggle", role: "x", name: "S", outcome: "inert", to: [] }], known).length, 1, "an unknown kind");
});

test("edges: each reference edge must have a clone edge of the same kind to a paired node, or the same no change", () => {
  const refInv = {
    candidates: [{ role: "button", name: "Open", outcome: "overlay", children: ["r_modal"] }],
    interactions: [
      { kind: "contextmenu", role: "gridcell", name: "Shift 7:00 AM-3:30 PM", outcome: "overlay", to: ["r_glance"] },
      { kind: "dblclick", role: "gridcell", name: "Tuesday", outcome: "overlay", to: ["r_day"] },
      { kind: "key", key: "alt+m", role: "shortcut", name: "alt+m", outcome: "overlay", to: ["r_menu"] },
      { kind: "key", key: "mod+j", role: "shortcut", name: "mod+j", outcome: "overlay", to: ["r_menu"], declared: { implemented: false, reason: "not built" } },
      { kind: "submit", case: "empty", role: "button", name: "Request", outcome: "state", to: ["r_msg"] },
      { kind: "submit", case: "valid", role: "button", name: "Request", outcome: "state", to: ["r_x"], blocked: ["POST /api/x"] },
      { kind: "drag", role: "separator", name: "Resize", outcome: "inert", to: [] },
      { kind: "upload", case: "accepted", role: "button", name: "File", accept: [".csv"], maxSize: "2 MB", outcome: "upload-needs-writes", unfired: "upload-needs-writes", to: [] },
      { kind: "contextmenu", role: "row", name: "Row 2", outcome: "sampled-out", unfired: "sampled-out", to: [] },
    ],
  };
  const pairOf = new Map([["r_modal", "c_modal"], ["r_glance", "c_glance"], ["r_day", "c_day"], ["r_msg", "c_msg"]]);
  const refNodes = { r_glance: { label: "modal: Shift glance" }, r_menu: { label: "menu: Quick menu" }, r_msg: { label: "submit: Request" } };
  const same = edgeDiff(refInv, { candidates: refInv.candidates.map((c) => ({ ...c, children: c.children.map((x) => pairOf.get(x)) })), interactions: refInv.interactions.map((r) => ({ ...r, to: r.to.map((x) => pairOf.get(x) ?? x) })) }, { pairOf, refNodes });
  // alt+m and mod+j lead to an unpaired menu on both sides: not a pair
  assert.deepEqual(same.failures.map((f) => f.key), ["key|alt+m||shortcut|alt+m"]);
  assert.equal(same.declared.length, 1, "a declared unimplemented shortcut is listed, not failed");

  const clone = {
    candidates: [{ role: "button", name: "Open", outcome: "overlay", children: ["c_modal"] }],
    interactions: [
      { kind: "contextmenu", role: "gridcell", name: "Shift 9:00 AM-5:30 PM", outcome: "inert", to: [] },
      { kind: "dblclick", role: "gridcell", name: "Tuesday", outcome: "overlay", to: ["c_day"] },
      { kind: "submit", case: "empty", role: "button", name: "Request", outcome: "inert", to: [] },
      { kind: "drag", role: "separator", name: "Resize", outcome: "state", to: ["c_drag"] },
      { kind: "upload", case: "accepted", role: "button", name: "File", accept: [".pdf"], maxSize: "2 MB", outcome: "upload-needs-writes", unfired: "upload-needs-writes", to: [] },
    ],
  };
  const d = edgeDiff(refInv, clone, { pairOf, refNodes, cloneNodes: { c_drag: { label: "drag: Resize" } } });
  const msgs = d.failures.map((f) => f.message);
  assert.ok(msgs.includes(`right-click on 'Shift 7:00 AM-3:30 PM' opens nothing on the clone (the reference opens "modal: Shift glance")`), msgs.join("\n"));
  assert.ok(msgs.includes(`key alt+m opens nothing on the clone (the reference opens "menu: Quick menu")`), "an unbound shortcut");
  assert.ok(msgs.some((m) => /^submit on 'Request' \[empty\] opens nothing on the clone/.test(m)), "a missing required message");
  assert.ok(msgs.some((m) => /^drag on 'Resize' does nothing on the reference, opens "drag: Resize" on the clone/.test(m)));
  assert.ok(msgs.some((m) => /^upload on 'File' \[accepted\] accepts \.csv on the reference, \.pdf on the clone/.test(m)));
  assert.equal(msgs.length, 5, msgs.join("\n"));
  assert.ok(d.notCompared.some((x) => /write/.test(x.why)), "a write row is the writes check's");
  assert.ok(d.notCompared.some((x) => x.why === "sampled-out"));
  assert.ok(!msgs.some((m) => /click on 'Open'/.test(m)), "the paired click passes");
});

test("identity: a route fragment is part of the URL, a plain one is not; old nodes stay loadable", () => {
  assert.equal(canonicalUrl("https://x.test/metaui#/list/Kiosk"), "https://x.test/metaui#/list/Kiosk");
  assert.notEqual(canonicalUrl("https://x.test/metaui#/list/Kiosk"), canonicalUrl("https://x.test/metaui#/list/ExceptionCategories"));
  assert.equal(canonicalUrl("https://x.test/timekeeping#!/timecard?utm_source=a&b=2"), "https://x.test/timekeeping#!/timecard?b=2");
  assert.equal(canonicalUrl("https://x.test/page#section"), "https://x.test/page", "a plain anchor is not a route");
  assert.equal(canonicalUrl("https://x.test/page#section", { anyHash: true }), "https://x.test/page#section");
  const g = Graph.create({});
  const a = g.addNode({ url: "https://x.test/metaui#/list/Kiosk", signature: ["a"] }).node;
  const b = g.addNode({ url: "https://x.test/metaui#/list/ExceptionCategories", signature: ["a"] }).node;
  assert.notEqual(a.id, b.id, "two hash routes are two nodes");
  assert.equal(a.href, "https://x.test/metaui#/list/Kiosk", "the fragment is kept for replay");
  const old = new Graph({ version: 1, meta: {}, nodes: { n_old: { id: "n_old", url: "https://x.test/metaui", href: "https://x.test/metaui", state: "", kind: "page", label: "old", depth: 0, entry: true, signature: ["a"], modules: [], template: null, status: "closed" } }, edges: {}, templates: {}, modules: {}, shell: null });
  assert.equal(old.node("n_old").url, "https://x.test/metaui", "an old node without a fragment stays as it is");
  assert.equal(viewKey("https://x.test/metaui#/list/Kiosk") === viewKey("https://x.test/metaui#/list/Other"), false, "views differ by route");
  assert.equal(viewKey("https://x.test/app#/item/7"), viewKey("https://x.test/app#/item/9"), "ids in a route are one family");
  const bounds = {};
  for (let i = 1; i <= 3; i++) admit(bounds, `https://x.test/app#/item/${i}`, 2);
  assert.ok(bounds.paths["https://x.test/app#/item/:id"].over === 1, "a route family is bounded like a path family");
});

test("scope: in-scope nodes outrank out-of-scope ones; an overlay inherits its opener's scope", () => {
  const g = Graph.create({});
  g.setWalkScope({ rules: [{ scope: "S02", url: "^/timekeeping" }, { scope: "OUT", url: "^/admin" }], ids: ["S02"] });
  const home = g.addNode({ url: "https://x.test/home", signature: ["h"], entry: true }).node;
  const admin = g.addNode({ url: "https://x.test/admin/a", signature: ["a"], interactive: 1 }).node;
  const tk = g.addNode({ url: "https://x.test/timekeeping#/list/Kiosk", signature: ["t"], interactive: 99 }).node;
  g.addEdge({ from: home.id, to: admin.id, kind: "navigation", element: { name: "Admin" } });
  g.addEdge({ from: home.id, to: tk.id, kind: "navigation", element: { name: "Timecard" } });
  assert.equal(g.next().id, home.id, "the entry first");
  assert.equal(g.next().id, tk.id, "in scope before a cheaper, equally deep out-of-scope page");
  const modal = g.addNode({ url: "https://x.test/timekeeping#/list/Kiosk", state: "modal:Edit", signature: ["m"], kind: "modal" }).node;
  g.addEdge({ from: tk.id, to: modal.id, kind: "click", element: { name: "Edit" } });
  assert.equal(modal.walkScope, "S02");
  assert.ok(g.inWalk(modal) && !g.inWalk(admin));
  assert.equal(g.next().id, modal.id);
});

test("entries: a file of URLs or a JSON route map", async () => {
  const { readEntriesFile } = await import("../explore.mjs");
  assert.deepEqual(readEntriesFile("/a#/list/Kiosk\n# comment\n\nhttps://o.test/b\n", "https://o.test"), ["https://o.test/a#/list/Kiosk", "https://o.test/b"]);
  assert.deepEqual(readEntriesFile(JSON.stringify(["/a", { path: "/b" }]), "https://o.test"), ["https://o.test/a", "https://o.test/b"]);
  assert.deepEqual(readEntriesFile(JSON.stringify({ timecard: "/timekeeping", planner: { route: "/planner" } }), "https://o.test"), ["https://o.test/timekeeping", "https://o.test/planner"]);
});

test("focus: the first stop where two Tab orders differ", () => {
  assert.equal(focusDiff({ order: ["a", "b"] }, { order: ["a", "b"] }), null);
  assert.deepEqual(focusDiff({ order: ["a", "b"] }, { order: ["b", "a"] }), { stop: 1, ref: "a", clone: "b" });
  assert.deepEqual(focusDiff({ order: ["a", "b"] }, { order: ["a"] }), { stop: 2, ref: "b", clone: "(end)" });
});

// ---------- the walker, live ----------

const jsonOf = (p) => JSON.parse(readFileSync(p, "utf8"));

async function setup(entry, prefix) {
  const site = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-inter-"));
  const profile = join(dir, "profile");
  const { open, save } = await import("../store.mjs");
  const ex = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${site.base}${entry}`, origin: site.base, prefix });
  await ex.readEntry(g, `${site.base}${entry}`, { profile });
  save(g, dir);
  return { ...site, dir, profile, g, ex };
}

describe("walker on /kit/: every interaction kind", { skip, timeout: 600_000 }, () => {
  let w;
  let home;
  let inv;
  before(async () => {
    w = await setup("/kit/", "/kit");
    const kb = join(w.dir, "keyboards.json");
    writeFileSync(kb, JSON.stringify({ rl: "fixture", product: "fixture", shortcuts: [{ keys: "alt+m", action: "open the quick menu", implemented: true }] }));
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 30, keyboards: kb, allowPost: [/\/kit\/api\/uploads/], widths: "off", log: () => {} });
    home = Object.values(w.g.data.nodes).find((n) => n.entry);
    inv = jsonOf(join(w.dir, home.info.artifacts, "inventory.json"));
  });
  after(() => w?.server.close());
  const row = (kind, pred = () => true) => inv.interactions.find((r) => r.kind === kind && pred(r));
  const target = (r) => w.g.data.nodes[r.to[0]];
  const edge = (kind, r) => Object.values(w.g.data.edges).find((e) => e.from === home.id && e.kind === kind && e.to === r.to[0]);

  test("right-click: a real contextmenu on the shift opens its glance, as a contextmenu edge", () => {
    const r = row("contextmenu", (x) => /Shift 7/.test(x.name));
    assert.equal(target(r)?.label, "modal: Shift glance");
    assert.ok(edge("contextmenu", r), "edge kind contextmenu");
    assert.equal(row("contextmenu", (x) => x.name === "Tuesday").outcome, "inert", "a cell without a menu is fired and records no change");
  });

  test("double-click: the day cell opens its panel, as a dblclick edge", () => {
    const r = row("dblclick", (x) => x.name === "Tuesday");
    assert.equal(target(r)?.label, "modal: Day detail");
    assert.ok(edge("dblclick", r));
  });

  test("drag: the resize handle moved by a fixed offset is a state, as a drag edge", () => {
    const r = row("drag", (x) => x.name === "Resize pane");
    assert.equal(r.outcome, "state");
    assert.equal(target(r).kind, "state");
    assert.ok(edge("drag", r));
  });

  test("keys: the documented alt+m opens the quick menu; Enter activates a control like its click", () => {
    const r = row("key", (x) => x.key === "alt+m");
    assert.equal(target(r)?.label, "menu: Quick menu");
    assert.ok(edge("key", r));
    const enter = row("key", (x) => x.key === "Enter" && x.name === "Request shift");
    assert.ok(enter && enter.sameAsClick, "Enter on the submit does what its click does");
    const menu = Object.values(w.g.data.nodes).find((n) => n.label === "menu: Quick menu");
    assert.equal(menu.status, "closed", "a node reached by a key edge is replayed and walked");
  });

  test("forms: empty and invalid submits show messages; valid input enables; the valid submit is a write, aborted and queued", () => {
    const empty = row("submit", (x) => x.case === "empty");
    assert.equal(empty.outcome, "state", "the required message is a state");
    assert.ok(row("submit", (x) => x.case === "invalid:Badge:pattern").to.length, "the pattern message is a state");
    assert.ok(row("submit", (x) => x.case === "invalid:Shift code:required"));
    const valid = row("input", (x) => x.case === "valid");
    assert.equal(valid.outcome, "state", "valid values change the validation state");
    assert.ok(edge("input", valid));
    const send = row("submit", (x) => x.case === "valid");
    assert.ok(send.blocked.some((b) => /POST .*\/kit\/api\/shift-requests/.test(b)), "the valid submit tried a write");
    assert.ok(!w.hits.writes.some((x) => /shift-requests/.test(x)), "and it never left the browser");
    const pend = readFileSync(join(w.dir, "pending-writes.jsonl"), "utf8");
    assert.match(pend, /shift-requests/, "queued for BLOCKED");
    assert.deepEqual(inv.forms[0].fields.map((f) => [f.name, f.required, f.pattern]), [["Shift code", true, null], ["Badge", false, "[A-Z]{2}-\\d{4}"]]);
  });

  test("uploads: accept list and size limit read off the UI; with writes allowed an accepted and a rejected file", () => {
    const ok = row("upload", (x) => x.case === "accepted");
    const bad = row("upload", (x) => x.case === "rejected");
    assert.deepEqual(ok.accept, [".csv", "text/csv"]);
    assert.equal(ok.maxSize, "2 MB");
    assert.ok(ok.to.length && bad.to.length, "both changed the page");
    assert.ok(w.hits.writes.includes("POST /kit/api/uploads"), "the accepted file was uploaded where writes are allowed");
  });

  test("every kind is recorded, every row accounted for, and the Tab order saved", () => {
    const kinds = new Set(inv.interactions.map((r) => r.kind));
    for (const k of ["contextmenu", "dblclick", "key", "drag", "input", "submit", "upload"]) assert.ok(kinds.has(k), `${k} recorded`);
    assert.equal(inv.invariant, "ok");
    const focus = jsonOf(join(w.dir, home.info.artifacts, "focus.json"));
    assert.deepEqual(focus.order.slice(0, 3), ['gridcell "Shift #:# AM-#:# PM"', 'gridcell "Tuesday"', 'separator "Resize pane"']);
    assert.ok(focus.order.includes('button "Request shift"'));
  });

  test("on the reference (no writes allowed) uploads are recorded, not fired", async () => {
    const w2 = await setup("/kit/", "/kit");
    try {
      await w2.ex.explore(w2.g, w2.dir, { profile: w2.profile, maxNodes: 1, widths: "off", log: () => {} });
      const h = Object.values(w2.g.data.nodes).find((n) => n.entry);
      const rows = jsonOf(join(w2.dir, h.info.artifacts, "inventory.json")).interactions.filter((r) => r.kind === "upload");
      assert.ok(rows.length && rows.every((r) => r.unfired === "upload-needs-writes" && r.accept.length), "accept list kept, nothing uploaded");
      assert.deepEqual(w2.hits.writes, [], "nothing reached the server");
    } finally {
      w2.server.close();
    }
  });
});

describe("walker on /spa/: hash routes, scope priority, entries file, bounds", { skip, timeout: 600_000 }, () => {
  let w;
  const order = [];
  before(async () => {
    w = await setup("/spa/", "/spa");
    const entries = join(w.dir, "entries.txt");
    writeFileSync(entries, `/spa/app#/list/Categories\n`);
    await w.ex.explore(w.g, w.dir, {
      profile: w.profile, maxNodes: 40, widths: "off", stateBound: 2,
      walkScope: { rules: [{ scope: "IN", url: "^/spa/app" }, { scope: "ADMIN", url: "^/spa/admin" }], ids: ["IN"] },
      entries: w.ex.readEntriesFile(readFileSync(entries, "utf8"), w.base),
      log: (s) => {
        const m = s.match(/^closed (n_\w+)/);
        if (m) order.push(m[1]);
      },
    });
  });
  after(() => w?.server.close());
  const nodes = () => Object.values(w.g.data.nodes);
  const at = (re) => nodes().filter((n) => n.kind === "page" && re.test(n.href ?? n.url));

  test("hash routes are separate nodes, each walked", () => {
    const kiosk = at(/#\/list\/Kiosk$/);
    const cats = at(/#\/list\/Categories$/);
    assert.equal(kiosk.length, 1);
    assert.equal(cats.length, 1);
    assert.notEqual(kiosk[0].id, cats[0].id);
    for (const n of [...kiosk, ...cats]) {
      assert.equal(n.status, "closed");
      assert.ok(!n.info.shallow && existsSync(join(w.dir, n.info.artifacts, "screenshot.png")));
    }
    assert.equal(kiosk[0].label, "Kiosk", "read off its own route, not the list home");
  });

  test("entries file: the seeded route is an entry", () => {
    assert.ok(at(/#\/list\/Categories$/)[0].entry);
  });

  test("in scope first; the out-of-scope area is closed shallowly and never expanded", () => {
    const admin = at(/\/spa\/admin$/)[0];
    assert.equal(admin.status, "closed");
    assert.ok(admin.info.shallow);
    assert.ok(w.hits.admin.length >= 1 && !w.hits.admin.some((p) => /\/a\d/.test(p)), `nothing under it was loaded (${w.hits.admin.join(", ")})`);
    const inScope = nodes().filter((n) => n.walkScope === "IN" && n.status === "closed").map((n) => n.id);
    const adminAt = order.indexOf(admin.id);
    assert.ok(inScope.length >= 6);
    for (const id of inScope) assert.ok(order.indexOf(id) < adminAt, `${w.g.data.nodes[id].label} walked before the admin area`);
  });

  test("an in-scope route family past the bound is never bounded", () => {
    const items = at(/#\/item\/\d+$/);
    assert.equal(items.length, 4, "all four items, with a bound of 2");
    assert.ok(items.every((n) => n.status !== "bounded"));
  });

  test("a plain fragment that rebuilds the page makes fragments part of identity", () => {
    assert.equal(w.g.data.meta.hashRoutes, true);
    const two = at(/\/spa\/app\/tabs#two$/);
    assert.equal(two.length, 1, `the #two tab is its own node (${nodes().map((n) => n.href).join(", ")})`);
  });
});
