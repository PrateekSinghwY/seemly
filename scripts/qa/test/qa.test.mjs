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
