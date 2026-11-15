// `O relabel`: saved widths.json labels brought up to the current readLabels rules offline, from
// each node's saved dom.html, without walking the site again.
//   relabel     a node saved under version 1 ("add_circleCreate") reads "Create", stamped
//   no DOM      a node with widths.json and no dom.html is marked needs-recapture, requeued by
//               `requeue --needs-recapture`
//   unaccounted a saved label the saved DOM does not produce offline: untouched, needs-recapture
//   lock        refused while supervise.pid or a live walk.lock holds the dir; a dead pid is stale
// The offline tests need Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LABELS_VERSION } from "../../qa/labels.mjs";
import { axNamesOf, labelCounts, remapLabels, staleLabels } from "../relabel.mjs";
import { open, save } from "../store.mjs";
import { DirBusy, acquire, holders } from "../walk-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

const O = (args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [join(here, "..", "run.mjs"), ...args], { env: { ...process.env, RL_REPO: repo }, timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` }),
    ),
  );

const EMPTY = { headings: [], nav: [], tabs: [], buttons: [], tableHeaders: [], fields: [], overflowX: false };
// What the walker saved before c2e33f4: innerText, so the Material Symbols ligature is in the label.
const V1 = { ...EMPTY, headings: ["h1 Setup"], buttons: ["add_circleCreate", "Cancel"] };
const DOM = `<!doctype html><html><head><link rel="stylesheet" href="https://cdn.example.com/app.css"><script src="/app.js"></script></head>
<body><main><h1>Setup</h1><button><span aria-hidden="true" class="material-symbols-outlined">add_circle</span>Create</button><button>Cancel</button></main></body></html>`;

/** A graph dir with three walked nodes saved under labels version 1. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "seemly-relabel-"));
  const g = open(dir, {});
  Object.assign(g.data.meta, { origin: "https://a.test", target: "https://a.test/app/" });
  const mk = (path, files) => {
    const n = g.addNode({ url: `https://a.test${path}`, signature: [path], label: path, entry: true }).node;
    const rel = join("nodes", n.id);
    mkdirSync(join(dir, rel), { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, rel, f), body);
    g.annotate(n.id, { artifacts: rel });
    g.setStatus(n.id, "closed");
    return n;
  };
  const widths = (labels) => JSON.stringify({ captured: 1440, height: 900, scope: null, widths: { 1024: labels, 1440: labels } });
  const setup = mk("/app/setup", { "dom.html": DOM, "widths.json": widths(V1) });
  const noDom = mk("/app/nodom", { "widths.json": widths(V1) });
  const lost = mk("/app/lost", { "dom.html": DOM, "widths.json": widths({ ...V1, buttons: [...V1.buttons, "Export"] }) });
  save(g, dir);
  return { dir, setup, noDom, lost };
}
const graph = (dir) => JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
const widthsOf = (dir, n) => JSON.parse(readFileSync(join(dir, "nodes", n.id, "widths.json"), "utf8"));

test("remapLabels: each saved label becomes what the current rules read from its element", () => {
  const pairs = { ...EMPTY, headings: [["h1 Setup", "h1 Setup"]], buttons: [["add_circleCreate", "Create"], ["more_vert", ""], ["Save", "Save"], ["Edit", "Edit"], ["Edit", "Edit row"]] };
  const r = remapLabels({ ...EMPTY, headings: ["h1 Setup"], buttons: ["add_circleCreate", "more_vert", "SAVE", "Export"] }, pairs);
  assert.deepEqual(r.labels.buttons, ["Create", "Save", "Export"], "the ligature goes, an icon-only name with nothing left is dropped, case from text-transform is undone");
  assert.equal(r.changed, 3);
  assert.deepEqual(r.unmapped, ["buttons|Export"]);
  assert.deepEqual(remapLabels({ ...EMPTY, buttons: ["Edit"] }, pairs).conflicts, ["buttons|Edit -> Edit / Edit row"]);
  // two controls that now read differently: the one visible offline decides, else the capture's AX tree
  const dup = { ...EMPTY, buttons: [["All Home Select hyperfind", "Select hyperfind", true], ["All Home Select hyperfind", "Location Select hyperfind", false]] };
  assert.deepEqual(remapLabels({ ...EMPTY, buttons: ["All Home Select hyperfind"] }, dup).labels.buttons, ["Select hyperfind"]);
  dup.buttons[1][2] = true;
  assert.equal(remapLabels({ ...EMPTY, buttons: ["All Home Select hyperfind"] }, dup).conflicts.length, 1);
  const ax = axNamesOf(`- banner:\n  - 'button "Select hyperfind"'\n  - heading "Setup" [level=1]`);
  assert.deepEqual(remapLabels({ ...EMPTY, buttons: ["All Home Select hyperfind"] }, dup, { axNames: ax }).labels.buttons, ["Select hyperfind"]);
});

test("relabel: v1 widths.json relabelled offline from dom.html; no DOM and unaccounted labels marked needs-recapture", { skip, timeout: 180_000 }, async () => {
  const { dir, setup, noDom, lost } = fixture();
  const g0 = graph(dir);
  assert.ok(staleLabels(g0.nodes[setup.id]), "an unstamped node is version 1");
  const st0 = await O(["status", "--dir", dir]);
  assert.match(st0.out, /LABELS\s+3 node\(s\) with stale labels \(older than v2\): run O relabel/);

  const dry = await O(["relabel", "--dir", dir, "--dry-run"]);
  assert.equal(dry.code, 0, dry.out);
  assert.match(dry.out, /DRY RUN RELABEL .*3 node\(s\) with stale labels · 1 relabelled \(2 label\(s\) changed\) · 0 unchanged, stamped v2 · 2 need recapture/);
  assert.deepEqual(widthsOf(dir, setup).widths[1024].buttons, V1.buttons, "a dry run writes nothing");
  assert.equal(graph(dir).nodes[setup.id].info.labelsVersion, undefined);

  const r = await O(["relabel", "--dir", dir]);
  assert.equal(r.code, 0, r.out);
  for (const w of ["1024", "1440"]) assert.deepEqual(widthsOf(dir, setup).widths[w].buttons, ["Create", "Cancel"], `@${w}`);
  assert.deepEqual(widthsOf(dir, setup).widths[1024].headings, ["h1 Setup"]);
  const g1 = graph(dir).nodes;
  assert.equal(g1[setup.id].info.labelsVersion, LABELS_VERSION);
  assert.equal(g1[setup.id].info.needsRecapture, undefined);
  assert.match(g1[noDom.id].info.needsRecapture, /no saved DOM/);
  assert.match(g1[lost.id].info.needsRecapture, /2 unmapped, 0 ambiguous \(1024:buttons\|Export/);
  assert.deepEqual(widthsOf(dir, lost).widths[1024].buttons, [...V1.buttons, "Export"], "a node not fully accounted for is left untouched");
  assert.equal(g1[lost.id].info.labelsVersion, undefined);

  const st1 = await O(["status", "--dir", dir]);
  assert.match(st1.out, /LABELS\s+2 node\(s\) with stale labels .* · 2 need recapture: requeue --needs-recapture/);
  const again = await O(["relabel", "--dir", dir, "--node", setup.id]);
  assert.match(again.out, /0 node\(s\) with stale labels .* 1 already current/, "a stamped node is not relabelled twice");

  const rq = await O(["requeue", "--dir", dir, "--needs-recapture"]);
  assert.match(rq.out, /requeued 2 needs-recapture node\(s\)/);
  const g2 = graph(dir).nodes;
  for (const n of [noDom, lost]) {
    assert.equal(g2[n.id].status, "frontier");
    assert.equal(g2[n.id].info.needsRecapture, undefined);
  }
  assert.equal(g2[setup.id].status, "closed");
  assert.deepEqual(labelCounts(open(dir), dir), { stale: 2, needsRecapture: 0 });
});

test("relabel refuses while a walk holds the dir: supervise.pid or a live walk.lock; a dead pid is stale", async () => {
  const { dir, setup } = fixture();
  // this test process stands in for a running supervise / explore (alive, not the relabel process)
  writeFileSync(join(dir, "supervise.pid"), String(process.pid));
  const a = await O(["relabel", "--dir", dir]);
  assert.equal(a.code, 5, a.out);
  assert.match(a.out, /relabel refused: .* supervise pid \d+/);
  writeFileSync(join(dir, "supervise.pid"), "999999999");
  writeFileSync(join(dir, "walk.lock"), JSON.stringify({ pid: process.pid, cmd: "explore", started: new Date().toISOString() }));
  const b = await O(["relabel", "--dir", dir, "--dry-run"]);
  assert.equal(b.code, 5, b.out);
  assert.match(b.out, /relabel refused: .* explore pid \d+/);
  assert.deepEqual(widthsOf(dir, setup).widths[1024].buttons, V1.buttons, "nothing was rewritten");
  assert.deepEqual(holders(dir).stale.map((h) => h.cmd), ["supervise"], "the dead supervise pid is stale, not a holder");

  // in-process: explore under its own supervise passes; anyone else is refused; release removes it
  writeFileSync(join(dir, "walk.lock"), JSON.stringify({ pid: 999999999, cmd: "explore" }));
  const release = acquire(dir, "explore");
  assert.equal(JSON.parse(readFileSync(join(dir, "walk.lock"), "utf8")).pid, process.pid, "a stale walk.lock is taken over");
  release();
  writeFileSync(join(dir, "supervise.pid"), String(process.ppid));
  assert.throws(() => acquire(dir, "explore", { supervisor: null }), DirBusy);
  acquire(dir, "explore", { supervisor: process.ppid })();
});
