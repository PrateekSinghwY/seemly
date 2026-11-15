// `O supervise`: the walk survives a lost login without a human re-running it.
//   stop rules   exit 4 stops, another failure retries once then stops, three chunks that close
//                nothing stop as "stalled" (fake chunks, no browser)
//   session loss on /sess/ the walk stops and waits for a sign-in, never walks on signed out
//   resume       once the fixture's browser signs in again (/sess/api/login), supervise re-exports
//                the login over CDP, proves it, requeues gaps and walks to frontier 0 by itself
// The browser tests need Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { open, save } from "../store.mjs";
import { supervise } from "../supervise.mjs";
import { start } from "./fixture/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";

function graphWithFrontier() {
  const dir = mkdtempSync(join(tmpdir(), "seemly-sup-"));
  const g = open(dir, {});
  Object.assign(g.data.meta, { origin: "http://127.0.0.1:1", target: "http://127.0.0.1:1/a" });
  g.addNode({ url: "http://127.0.0.1:1/a", signature: ["main|h1"], label: "A", entry: true });
  save(g, dir);
  return dir;
}
const quiet = { waitForLogin: async () => true, requeue: async () => {} };

test("stalled: three chunks in a row that close no node stop the loop as stalled", async () => {
  const dir = graphWithFrontier();
  const lines = [];
  let chunks = 0;
  const r = await supervise({ dir, ...quiet, log: (s) => lines.push(s), runChunk: async () => (chunks++, { code: 0 }) });
  assert.equal(r.code, 5);
  assert.match(r.reason, /^stalled/);
  assert.equal(chunks, 3);
  assert.ok(lines.some((l) => /STOPPED stalled/.test(l)));
});

test("exit 4 stops at once; any other failure is retried once, then stops with the reason", async () => {
  const dir = graphWithFrontier();
  let n = 0;
  const four = await supervise({ dir, ...quiet, log: () => {}, runChunk: async () => (n++, { code: 4 }) });
  assert.deepEqual([four.code, four.reason, n], [4, "scope coverage", 1]);
  n = 0;
  const two = await supervise({ dir, ...quiet, log: () => {}, runChunk: async () => (n++, { code: 1, err: "TypeError: boom" }) });
  assert.equal(two.code, 1);
  assert.match(two.reason, /boom/);
  assert.equal(n, 2, "one retry, then stop");
});

async function freePort() {
  const s = createServer().listen(0);
  await new Promise((r) => s.once("listening", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** The /sess/ graph, an empty saved login, and a headless "human's window" reachable over CDP. */
async function setupSess() {
  const site = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-sup-walk-"));
  const state = join(dir, "auth-ref.json");
  writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  const ex = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${site.base}/sess/`, origin: site.base, prefix: "/sess" });
  await ex.readEntry(g, `${site.base}/sess/`, { storageState: state });
  save(g, dir);
  const { chromium } = await (await import("../../lib/pw.mjs")).playwright();
  const port = await freePort();
  const window = await chromium.launchPersistentContext(join(dir, "human"), { headless: true, args: [`--remote-debugging-port=${port}`] });
  return { ...site, dir, state, window, cdp: `http://127.0.0.1:${port}` };
}

function superviseProc(w, extra = []) {
  const args = [join(here, "..", "run.mjs"), "supervise", "--dir", w.dir, "--state", w.state, "--login-cdp", w.cdp, "--poll", "1",
    "--max-nodes", "10", "--widths", "off", "--retries", "1", "--backoff-ms", "50", "--no-interactions", ...extra];
  const child = spawn(process.execPath, args, { env: { ...process.env, RL_REPO: repo }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", () => {});
  const exited = new Promise((r) => child.on("close", (code) => r(code)));
  const until = async (re, ms = 240_000) => {
    const end = Date.now() + ms;
    while (!re.test(out)) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${re}; output:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  return { child, exited, until, out: () => out };
}

const graphNodes = (dir) => Object.values(JSON.parse(readFileSync(join(dir, "graph.json"), "utf8")).nodes);

test("session loss: the walk stops and waits for a sign-in; with none it ends as exit 3, the node back on the frontier", { skip, timeout: 300_000 }, async () => {
  const w = await setupSess();
  try {
    const p = superviseProc(w, ["--max-wait", "0.1"]);
    const code = await p.exited;
    assert.equal(code, 3, p.out());
    assert.match(p.out(), /WAITING FOR SIGN-IN since \d{4}-/);
    assert.match(readFileSync(join(w.dir, "supervise.log"), "utf8"), /WAITING FOR SIGN-IN since/);
    const home = graphNodes(w.dir).find((n) => /\/sess$/.test(n.url));
    assert.equal(home.status, "frontier", "the node in hand is back on the frontier");
    assert.ok(!graphNodes(w.dir).some((n) => n.status === "gap"), "nothing walked signed out became a gap");
  } finally {
    await w.window.close();
    w.server.close();
  }
});

test("resume: after the human signs in again, supervise re-exports, proves the login and walks to frontier 0 on its own", { skip, timeout: 400_000 }, async () => {
  const w = await setupSess();
  try {
    const p = superviseProc(w);
    await p.until(/WAITING FOR SIGN-IN since/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(p.child.exitCode, null, "still waiting, not exited");
    const page = await w.window.newPage();
    await page.goto(`${w.base}/sess/api/login`);
    const code = await p.exited;
    assert.equal(code, 0, p.out());
    assert.match(p.out(), /SIGNED IN/);
    assert.match(p.out(), /DONE frontier 0/);
    const nodes = graphNodes(w.dir);
    assert.equal(nodes.filter((n) => n.status === "frontier").length, 0);
    assert.ok(nodes.some((n) => /\/sess\/team$/.test(n.url) && n.status === "closed"), "the page past the loss was walked");
    assert.ok(JSON.parse(readFileSync(w.state, "utf8")).cookies.some((c) => c.name === "sess"), "the new login was saved");
  } finally {
    await w.window.close();
    w.server.close();
  }
});
