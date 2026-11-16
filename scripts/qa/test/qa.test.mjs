// Each QA script must fail on the defect it exists for and pass on a clean page. Runs the
// scripts as the skill runs them (child processes) against two tiny local apps: a "reference"
// and a "clone" carrying one planted defect of each kind.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
// Under the eval runner a missing browser is a failure, never a vacuous skip.
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

const page = (body) => `<!doctype html><html lang="en"><head><title>Rates</title><style>body{margin:0;font-family:sans-serif}</style></head><body>
<header><nav><a href="/">Home</a> <a href="/rates">Rates</a></nav></header><main>${body}</main></body></html>`;
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const SR = `<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">Screen reader only label</span>`;
const REF = page(`${SR}<h1>Rates</h1><button>Export</button><table><tr><th>Date</th><th>Rate</th></tr></table>
<article><img src="/a.png" alt="Harbor Loft"><h3>Harbor Loft</h3></article><article><img src="/b.png" alt="Seaside Flat"><h3>Seaside Flat</h3></article>`);
const CLONE = page(`<h1>Rates</h1><button>Export</button><button>Chat</button><table><tr><th>Date</th></tr></table>
<article><img src="/a.png" alt="Harbor Loft"><h3>Harbor Loft</h3></article><article><img src="/a.png" alt="Seaside Flat"><h3>Seaside Flat</h3></article>
<div style="width:80px;overflow:hidden;white-space:nowrap">A long label that is cut off</div>
<button><svg width="10" height="10"></svg></button><button id="noop">Refresh</button><div style="width:1300px;height:4px"></div>`);

function serve(handler) {
  const server = createServer(handler);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const site = (html) => (req, res) => {
  if (req.url.endsWith(".png")) return res.writeHead(200, { "content-type": "image/png" }).end(PIXEL);
  res.writeHead(200, { "content-type": "text/html" }).end(html);
};

function run(script, args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(here, "..", script), ...args], { cwd, env: { ...process.env, RL_REPO: repo, SEEMLY_DISCOVERY: join(cwd, "d"), SEEMLY_PROFILE: join(cwd, "profile") }, timeout: 240_000 }, (err, stdout, stderr) =>
      resolve({ code: err?.code ?? 0, out: stdout + stderr, record: (name) => JSON.parse(readFileSync(join(cwd, "never_to_be_pushed/discovery/checks", `${name}.json`), "utf8")) }),
    );
  });
}

test("struct_audit: an invented button and a missing column fail; identical pages pass", { skip, timeout: 300_000 }, async () => {
  const ref = await serve(site(REF));
  const clone = await serve(site(CLONE));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const bad = await run("struct_audit.mjs", ["--ref", `${ref.base}/rates`, "--clone", `${clone.base}/rates`], cwd);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /buttons: .*invented \[.*Chat/);
    assert.match(bad.out, /tableHeaders: missing \[Rate\]/);
    assert.equal(bad.record("structure_labels").status, "fail");
    const good = await run("struct_audit.mjs", ["--ref", `${ref.base}/rates`, "--clone", `${ref.base}/rates`], cwd);
    assert.equal(good.code, 0, good.out);
    assert.equal(good.record("structure_labels").ran, true);
  } finally {
    ref.server.close();
    clone.server.close();
  }
});

// Setup pages: the reference renders "Create"; the clone puts a Material Symbols ligature in front
// of it. Labels are accessible names, so the icon is not part of the label.
const ICON_REF = page(`<h1>Setup</h1><button>Create</button><button aria-label="Edit row">Edit</button><button id="d">Delete</button>
<label for="q">Search</label><input id="q">`);
const ICON_CLONE = page(`<h1><span class="material-icons">tune</span>Setup</h1>
<button><span aria-hidden="true" class="material-symbols-outlined">add_circle</span>Create</button>
<button aria-labelledby="el"><span class="material-symbols-outlined">edit</span><span id="el">Edit row</span></button>
<button><i style="font-family:'Material Symbols Outlined'">delete</i><span role="img" aria-label=""><b>trash</b></span>Delete</button>
<label for="q"><span aria-hidden="true">search</span>Search</label><input id="q">`);
const ICON_WRONG = ICON_CLONE.replace("add_circle</span>Create", "add_circle</span>Create new");

test("struct_audit: icon ligatures are not label text; a real label difference still fails", { skip, timeout: 300_000 }, async () => {
  const ref = await serve(site(ICON_REF));
  const clone = await serve(site(ICON_CLONE));
  const wrong = await serve(site(ICON_WRONG));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const ok = await run("struct_audit.mjs", ["--ref", `${ref.base}/setup`, "--clone", `${clone.base}/setup`], cwd);
    assert.equal(ok.code, 0, ok.out);
    const rec = JSON.parse(readFileSync(join(cwd, "d", "qa", "struct", "setup-1440.json"), "utf8"));
    assert.deepEqual(rec.clone.buttons, ["Create", "Edit row", "Delete"]);
    assert.deepEqual(rec.clone.headings, ["h1 Setup"]);
    assert.deepEqual(rec.clone.fields, ["Search"]);
    const bad = await run("struct_audit.mjs", ["--ref", `${ref.base}/setup`, "--clone", `${wrong.base}/setup`], cwd);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /buttons: missing \[Create\] invented \[Create new\]/);
  } finally {
    ref.server.close();
    clone.server.close();
    wrong.server.close();
  }
});

test("width_sweep: overflow that appears only below 1300px is caught at that width", { skip, timeout: 300_000 }, async () => {
  const ref = await serve(site(REF));
  const clone = await serve(site(CLONE));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const r = await run("width_sweep.mjs", ["--ref", `${ref.base}/rates`, "--clone", `${clone.base}/rates`, "--widths", "1280,1440"], cwd);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /@1280 .*overflow ref=false clone=true/);
    assert.doesNotMatch(r.out, /@1440 .*overflow/);
    assert.equal(r.record("width_sweep").count, 2);
  } finally {
    ref.server.close();
    clone.server.close();
  }
});

test("human_eye: stand-in image, clipped text, unnamed and dead controls, overflow", { skip, timeout: 300_000 }, async () => {
  const clone = await serve(site(CLONE));
  const ref = await serve(site(REF));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const r = await run("human_eye.mjs", ["--url", `${clone.base}/rates`, "--dead-controls", "--width", "1280"], cwd);
    assert.equal(r.code, 1, r.out);
    for (const k of ["stand-in-image", "clipped", "unnamed-control", "page-overflow", "dead-control"]) assert.match(r.out, new RegExp(k), `${k} found`);
    assert.match(r.out, /"Refresh" does nothing/);
    assert.equal(r.record("distinct_images").status, "fail");
    const clean = await run("human_eye.mjs", ["--url", `${ref.base}/rates`], cwd);
    assert.equal(clean.code, 0, clean.out);
  } finally {
    clone.server.close();
    ref.server.close();
  }
});

// 2026-11-16 (UKG): flex rows with min-height 0 shrank in a scroller and painted wrapped text
// over the next row; a justify-end footer around a justify-between child put "Back" and
// "Submit" 0px apart. The clean page holds the look-alikes that must not fire: a menu laid over
// text, a bordered toolbar with no gaps, a padded pill beside a link, inline links split by a space.
const BTN = "border:0;background:none;padding:0;font:inherit;color:#036";
const OVERLAP = page(`<h1>Request</h1>
<ul style="display:flex;flex-direction:column;height:100px;width:140px;overflow-y:auto;margin:0;padding:0;list-style:none">
${["Morning shift swap request", "Evening shift cover request", "Weekend availability change", "Holiday time off request"].map((t) => `<li style="min-height:0;flex:1 1 auto;line-height:20px">${t}</li>`).join("")}
</ul>
<footer style="display:flex;justify-content:flex-end;width:400px"><button style="${BTN}">Back</button><div style="display:flex;justify-content:space-between"><a href="/submit" style="color:#036">Submit</a><button style="${BTN};padding:4px 12px;border-radius:12px;background:#036;color:#fff">Review</button></div></footer>`);
const LOOKALIKES = page(`<h1>Request</h1>
<div style="position:relative"><p>Shift notes for the week ahead are listed here.</p>
<div role="menu" style="position:absolute;top:0;left:0;background:#fff;border:1px solid #888"><button role="menuitem" style="${BTN}">Open details</button></div></div>
<div role="toolbar" aria-label="Format" style="display:flex"><button style="${BTN}">Bold</button><button style="${BTN};border-left:1px solid #888">Italic</button><button style="${BTN};border-left:1px solid #888">Underline</button></div>
<footer style="display:flex;gap:2px"><a href="/submit" style="color:#036">Submit</a><button style="${BTN};padding:4px 12px;border-radius:12px;background:#036;color:#fff">Review</button></footer>
<p><a href="/a">Today</a> <a href="/b">Tomorrow</a></p>`);

test("human_eye: text painted over text and controls touching fail; overlays and toolbars pass", { skip, timeout: 300_000 }, async () => {
  const bad = await serve(site(OVERLAP));
  const ok = await serve(site(LOOKALIKES));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const r = await run("human_eye.mjs", ["--url", `${bad.base}/request`, "--width", "1280"], cwd);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /text-overlap .*request/i);
    assert.match(r.out, /controls-touching .*"Back" and "Submit" 0px apart/);
    assert.doesNotMatch(r.out, /"Submit" and "Review"/);
    const clean = await run("human_eye.mjs", ["--url", `${ok.base}/request`, "--width", "1280"], cwd);
    assert.equal(clean.code, 0, clean.out);
  } finally {
    bad.server.close();
    ok.server.close();
  }
});

// 2026-11-16 (UKG sweep, 238 page runs): each look-alike below fired before its fix. A drawer
// laid over page buttons gave a negative gap (controls in another layer); Material glyph names
// ("calendar_month", "more_vert") read as words; a row scrolled under a sticky tab strip, beside
// a button outside the scroller, kept its full box. A label wrapping to three lines in a 36px
// field with overflow visible painted past the field and nothing reported it.
// The fixed drawer keeps its static position, so Close lands on Approve's row, over its left end.
const DRAWER = page(`<h1>Request</h1>
<aside role="dialog" aria-label="Filters" style="position:fixed;left:0;width:40px;background:#fff"><button style="${BTN};width:40px;margin-top:8px;text-align:left">Close</button></aside>
<div style="padding:8px"><button style="${BTN}">Approve</button></div>`);
const GLYPH = "display:inline-block;width:24px;white-space:nowrap;overflow:visible";
const ICONS = page(`<h1>Request</h1>
<button style="${BTN};display:inline-flex;align-items:center"><span class="material-symbols-outlined" style="${GLYPH}">calendar_month</span><span style="display:inline-block">Date</span><span style="font-family:'Material Icons';${GLYPH}">arrow_drop_down</span></button>
<div style="display:flex"><button style="${BTN}">Filter</button><button style="${BTN}" aria-label="More"><span class="material-icons" style="${GLYPH}">more_vert</span></button></div>`);
// Row 3 is scrolled above the scroller, level with Export; row 5 sits under the sticky strip,
// level with Print.
const STICKY = page(`<h1>Request</h1>
<div style="display:flex;align-items:flex-start">
<div id="sc" style="margin-top:48px;height:96px;width:200px;overflow-y:auto">
<div style="position:sticky;top:0;height:24px;background:#fff;display:flex;gap:12px"><button style="${BTN}">Day</button><button style="${BTN}">Week</button></div>
${Array.from({ length: 12 }, (_, i) => `<div style="height:24px;display:flex;justify-content:flex-end"><button style="${BTN}">Edit ${i + 1}</button></div>`).join("")}
</div><div><div style="height:24px"><button style="${BTN}">Export</button></div><div style="height:24px"></div><div style="height:24px"><button style="${BTN}">Print</button></div></div></div>
<script>document.getElementById("sc").scrollTop = 120</script>`);
const SPILL = page(`<h1>Request</h1><div style="height:36px;width:110px;border:1px solid #888;margin-bottom:40px"><label style="display:block;line-height:18px">Scheduled hours in each pay period</label></div>`);
const SPILL_OK = page(`<h1>Request</h1>${SR}
<div style="height:36px;width:110px;border:1px solid #888"><label style="display:block;line-height:18px">Hours</label></div>
<div style="height:36px;width:110px;border:1px solid #888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Scheduled hours in each pay period</div>
<div style="height:36px;width:110px;line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">Scheduled hours in each pay period</div>`);

test("human_eye: drawer over buttons, icon glyphs and rows under a sticky strip pass; text spilling out of a 36px field fails", { skip, timeout: 300_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  for (const [name, html] of [["drawer", DRAWER], ["icons", ICONS], ["sticky", STICKY], ["spill-ok", SPILL_OK]]) {
    const app = await serve(site(html));
    try {
      const r = await run("human_eye.mjs", ["--url", `${app.base}/request`, "--width", "1280"], cwd);
      assert.equal(r.code, 0, `${name}: ${r.out}`);
    } finally {
      app.server.close();
    }
  }
  const bad = await serve(site(SPILL));
  try {
    const r = await run("human_eye.mjs", ["--url", `${bad.base}/request`, "--width", "1280"], cwd);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /text-spill .*"Scheduled hours in each pay period" paints \d+px past a 38px-high box/);
  } finally {
    bad.server.close();
  }
});

test("write_roundtrip: a write that persists passes; one that only answers 200 fails", { skip, timeout: 300_000 }, async () => {
  const store = { name: "Seaside Flat" };
  const app = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/api/listing" && req.method === "PATCH") Object.assign(store, JSON.parse(body));
      if (req.url === "/api/fake" && req.method === "PATCH") return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (req.url.startsWith("/api/")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(store));
      res.writeHead(200, { "content-type": "text/html" }).end(page(`<h1>${store.name}</h1>`));
    });
  });
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const spec = (path) => [{ name: "rename", write: { method: "PATCH", path, body: { name: "Harbor Loft" } }, expect: [{ path: "/api/listing", pointer: "/name", equals: "Harbor Loft" }], page: { path: "/listing", text: "Harbor Loft" }, restore: { method: "PATCH", path: "/api/listing", body: { name: "Seaside Flat" } } }];
    writeFileSync(join(cwd, "good.json"), JSON.stringify(spec("/api/listing")));
    writeFileSync(join(cwd, "bad.json"), JSON.stringify(spec("/api/fake")));
    const good = await run("write_roundtrip.mjs", ["--spec", "good.json", "--api", app.base, "--web", app.base], cwd);
    assert.equal(good.code, 0, good.out);
    assert.equal(store.name, "Seaside Flat", "restored");
    const bad = await run("write_roundtrip.mjs", ["--spec", "bad.json", "--api", app.base, "--web", app.base], cwd);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /read \/api\/listing\/name = "Seaside Flat", wrote "Harbor Loft"/);
    assert.match(bad.out, /does not show "Harbor Loft" after load/);
  } finally {
    app.server.close();
  }
});

test("edition_gate: a logged-out profile and a Chrome reading that disagrees both fail", { skip, timeout: 300_000 }, async () => {
  const ref = await serve(site(REF));
  const cwd = mkdtempSync(join(tmpdir(), "qa-"));
  try {
    const out = await run("edition_gate.mjs", ["--url", `${ref.base}/rates`, "--logged-in", "text=Sign out", "--theme", "light"], cwd);
    assert.equal(out.code, 1, out.out);
    assert.match(out.out, /logged-in marker/);
    const pw = JSON.parse(out.out.match(/PLAYWRIGHT (\{.*\})/)[1]);
    const same = await run("edition_gate.mjs", ["--url", `${ref.base}/rates`, "--theme", "light", "--chrome", JSON.stringify(pw)], cwd);
    assert.equal(same.code, 0, same.out);
    const other = await run("edition_gate.mjs", ["--url", `${ref.base}/rates`, "--chrome", JSON.stringify({ ...pw, theme: "dark" })], cwd);
    assert.equal(other.code, 1);
    assert.match(other.out, /theme: Chrome "dark", Playwright "light"/);
  } finally {
    ref.server.close();
  }
});
