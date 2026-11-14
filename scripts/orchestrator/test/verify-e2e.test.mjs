// Phase D end to end: walk the "ref" and "clone" fixture sites, pair their nodes, verify every
// pair, and prove verify catches each planted difference on its own channel (one label, one
// pixel region, one request field, one computed style, one width-only layout, one websocket
// read field, one dead button inside a modal), judges the modal on its own region, lets a
// masked synthetic name through, round-trips the clone's write, passes the identical page on
// every check, and that status and report count from the graph plus the records.
// Needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodePng, pixelDiff } from "../verify.mjs";
import { startPair } from "./fixture/pair.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}

const O = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [join(here, "..", "run.mjs"), ...args], { env: { ...process.env, RL_REPO: repo }, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }),
    ),
  );

async function walk(base) {
  const dir = mkdtempSync(join(tmpdir(), "seemly-verify-"));
  const profile = join(dir, "profile");
  const { open, save } = await import("../store.mjs");
  const { explore, readEntry } = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${base}/app/`, origin: base, prefix: "/app" });
  await readEntry(g, `${base}/app/`, { profile });
  save(g, dir);
  const r = await explore(g, dir, { profile, maxNodes: 40, log: () => {} });
  assert.ok(r.closed, `walk of ${base} closed`);
  return { dir, g };
}

test("verify catches label, pixels, request, style, widths, ws read and a dead modal button; masks, writes, status and report", { skip: !hasPw && "playwright not resolvable from RL_REPO", timeout: 900_000 }, async () => {
  const sites = await startPair();
  try {
    const ref = await walk(sites.ref.base);
    const clone = await walk(sites.clone.base);
    assert.deepEqual(sites.ref.state.writes, [], "the reference walk wrote nothing");

    const map = join(ref.dir, "scope.json");
    writeFileSync(map, JSON.stringify({ rules: [{ scope: "S01", url: "^/app/$" }, { scope: "S02", url: "^/app/reports" }] }));
    for (const d of [ref.dir, clone.dir]) assert.equal((await O(["scope", "--dir", d, "--map", map])).code, 0);

    const cmp = await O(["compare", "--ref", ref.dir, "--clone", clone.dir]);
    assert.match(cmp.out, /pairs \d+ · ref-only \d+/);
    const pairs = JSON.parse(readFileSync(join(clone.dir, "pairs.json"), "utf8"));
    const pairOf = (re, kind = "page") => pairs.pairs.find((p) => p.kind === kind && re.test(new URL(p.ref.url).pathname));
    const home = pairOf(/^\/app\/$/);
    const reports = pairOf(/^\/app\/reports$/);
    const modal = pairs.pairs.find((p) => p.kind === "modal" && /Filters/.test(p.ref.label));
    assert.ok(home && reports && modal, `home, reports and the filters modal pair (${pairs.pairs.map((p) => p.ref.label).join(", ")})`);
    assert.ok(pairs.refOnly.some((p) => /example\.org/.test(p.ref.url) && /out of scope/.test(p.reason)), "the external link is ref-only with its reason");

    const masks = join(clone.dir, "masks.json");
    writeFileSync(masks, JSON.stringify({ masks: [{ selector: ".person", reason: "synthetic person name" }] }));
    const writes = join(clone.dir, "writes.json");
    writeFileSync(writes, JSON.stringify([{
      at: "/app/reports", name: "save note",
      write: { method: "POST", path: "/api/notes", body: { text: "Quarterly review" } },
      expect: [{ path: "/api/notes", pointer: "/text", equals: "Quarterly review" }],
      page: { path: "/app/reports", text: "Quarterly review" },
      restore: { method: "POST", path: "/api/notes", body: { text: "" } },
    }]));

    const wsMap = join(clone.dir, "ws-map.json");
    writeFileSync(wsMap, JSON.stringify({ "/shifts/list": { method: "GET", path: "/api/shifts" }, "/notes/count": { method: "GET", path: "/api/notes/count" } }));
    const refHome = JSON.parse(readFileSync(join(ref.dir, "graph.json"), "utf8")).nodes[home.ref.id];
    for (const f of ["styles.json", "widths.json"]) assert.ok(existsSync(join(ref.dir, refHome.info.artifacts, f)), `the walker saved ${f}`);

    const v = await O(["verify", "--ref", ref.dir, "--clone", clone.dir, "--masks", masks, "--writes", writes, "--ws-map", wsMap, "--dead-controls"]);
    assert.equal(v.code, 1, `verify exits 1 when a pair fails:\n${v.out}`);
    const cg = JSON.parse(readFileSync(join(clone.dir, "graph.json"), "utf8"));
    const hv = cg.nodes[home.clone.id].verify;
    assert.equal(hv.ref, home.ref.id);

    // label: structure and accessibility tree
    assert.equal(hv.structure.status, "fail");
    assert.match(hv.structure.reason, /missing on the clone: button "Open filters"/);
    assert.match(hv.structure.reason, /only on the clone: button "Show filters"/);
    // pixel region: the Status panel, while the masked name is not counted
    assert.equal(hv.pixels.status, "fail");
    assert.ok(hv.pixels.regions.some((r) => /Status/.test(r.name)), `Status region differs (${JSON.stringify(hv.pixels.regions)})`);
    const px = JSON.parse(readFileSync(join(clone.dir, "verify", home.clone.id, "pixels.detail.json"), "utf8"));
    assert.ok(px.masks.length >= 1 && px.masked > 0, "the name mask was applied");
    const art = join(clone.dir, "verify", home.clone.id);
    const [refPng, clonePng] = ["ref.png", "clone.png"].map((f) => decodePng(readFileSync(join(art, f))));
    const unmasked = pixelDiff(refPng, clonePng).differing;
    assert.equal(pixelDiff(refPng, clonePng, { masks: px.masks }).differing, px.differing);
    assert.ok(unmasked > px.differing, `the differing name is real and the mask hid it (${unmasked} unmasked vs ${px.differing})`);
    for (const f of ["ref.png", "clone.png", "diff.png", "pixels.json", "structure.json", "style.json", "human_eye.json", "widths.json", "api.json", "writes.json"]) assert.ok(existsSync(join(clone.dir, "verify", home.clone.id, f)), f);
    // request field, and the websocket read's mirror missing a response field
    assert.equal(hv.api.status, "fail");
    assert.match(hv.api.reason, /GET \/api\/summary: query keys missing period; query keys only on the clone range/);
    assert.match(hv.api.reason, /WS \/shifts\/list -> GET \/api\/shifts: response fields missing shifts\[\]\.end/);
    assert.doesNotMatch(hv.api.reason, /request fields/, "the mirrored request (week) matches");
    // computed style: the heading's weight, matched by role and name
    assert.equal(hv.style.status, "fail");
    assert.match(hv.style.reason, /heading "Overview" font-weight 700 vs 500/);
    // widths: Export is missing below 1100px on the clone, present at every wider width
    assert.equal(hv.widths.status, "fail");
    assert.match(hv.widths.reason, /@1024: buttons missing Export/);
    assert.doesNotMatch(hv.widths.reason, /@1280|@1440/);
    // the clean channel passes, dead-control sweep included
    assert.equal(hv.human_eye.status, "pass", hv.human_eye.reason);
    assert.match(JSON.parse(readFileSync(join(clone.dir, "verify", home.clone.id, "human_eye.detail.json"), "utf8")).deadControls, /^run/);
    assert.equal(hv.writes.status, "n/a");
    assert.equal(hv.passed, false);
    const rec = JSON.parse(readFileSync(join(clone.dir, "verify", home.clone.id, "structure.json"), "utf8"));
    assert.deepEqual(Object.keys(rec).sort(), ["at", "count", "ran", "reason", "status"], "check-record shape");

    // the identical page passes everything, its write included
    const rv = cg.nodes[reports.clone.id].verify;
    for (const c of ["pixels", "structure", "style", "human_eye", "widths", "api", "writes"]) assert.equal(rv[c].status, "pass", `${c}: ${rv[c].reason}`);
    const rapi = JSON.parse(readFileSync(join(clone.dir, "verify", reports.clone.id, "api.detail.json"), "utf8"));
    assert.deepEqual(rapi.refWs, ["/notes/count"], "the identical page's socket read was compared, and its mirror matched");
    assert.equal(rv.passed, true);
    assert.equal(cg.nodes[reports.clone.id].status, "verified");
    assert.ok(sites.clone.state.writes.length >= 2, "the round trip wrote to the clone (and restored)");
    assert.deepEqual(sites.ref.state.writes, [], "verify never writes to the reference");

    // the modal: its own AX scope matches; the page behind it carries the planted differences
    const mv = cg.nodes[modal.clone.id].verify;
    assert.equal(mv.structure.status, "pass", mv.structure.reason);
    // ...and its pixels, style and widths are judged on the overlay's region, so the page's
    // planted differences (Status colour, heading weight, Export at 1024) do not leak in
    for (const c of ["pixels", "style", "widths"]) assert.equal(mv[c].status, "pass", `modal ${c}: ${mv[c].reason}`);
    const mpx = JSON.parse(readFileSync(join(clone.dir, "verify", modal.clone.id, "pixels.detail.json"), "utf8"));
    assert.ok(mpx.crop && mpx.crop.width < 1000, `cropped to the overlay (${JSON.stringify(mpx.crop)})`);
    // the dead button inside the modal fails the human eye, on the modal, not the page
    assert.equal(mv.human_eye.status, "fail");
    assert.match(mv.human_eye.reason, /dead-control "Apply" does nothing/);
    assert.doesNotMatch(mv.human_eye.reason, /Close/);
    assert.deepEqual(sites.clone.state.writes.filter((w) => !/Quarterly review|"text":""/.test(w)), [], "the dead-control sweep sent no write");

    // status and report count from the graph plus the records
    const st = await O(["status", "--dir", clone.dir]);
    assert.match(st.out, /VERIFY\s+verified 1 \/ built 3 \/ ref-only \d+/);
    const s2 = await O(["status", "--dir", clone.dir, "--scope", "S02"]);
    assert.match(s2.out, /VERIFY\s+verified 1 \/ built 1 \/ ref-only 0/);
    const s1 = await O(["status", "--dir", clone.dir, "--scope", "S01"]);
    assert.match(s1.out, /VERIFY\s+verified 0 \/ built 2/);
    const rp = await O(["report", "--clone", clone.dir, "--scope", "S01"]);
    assert.equal(rp.code, 0, rp.out);
    const md = readFileSync(join(clone.dir, "verify", "report-S01.md"), "utf8");
    assert.match(md, /\| \*\*FAIL\*\* \| \*\*FAIL\*\* \| \*\*FAIL\*\* \| pass \| \*\*FAIL\*\* \| \*\*FAIL\*\* \| n\/a \| no \|/);
    assert.match(md, /Open filters/);

    // one node, by id: only that pair runs
    const one = await O(["verify", "--ref", ref.dir, "--clone", clone.dir, "--node", reports.ref.id, "--masks", masks, "--writes", writes, "--ws-map", wsMap]);
    assert.equal(one.code, 0, one.out);
    assert.equal(one.out.split("\n").filter((l) => /^[✓✗] /.test(l)).length, 1);
  } finally {
    await sites.close();
  }
});
