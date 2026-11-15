// `O supervise`: run `explore` in chunks until the frontier is empty, and survive a lost login.
//
//   supervise [explore flags...] [--chunk N] [--poll 30] [--min-cookies 1] [--max-wait <minutes>]
//             [--state <file>] [--login-cdp <url>] [--domain <site>] [--check-url <url>]
//
// Each chunk is `run.mjs explore --max-nodes <chunk>` with every other flag passed through; its
// status lines and a one-line summary go to <dir>/supervise.log. On exit 3 (login lost) it prints
// "WAITING FOR SIGN-IN since <time>", then every --poll seconds copies the login out of the
// human's window (export-login.mjs over --login-cdp) and proves it: a headless page with that
// storage state must reach the entry URL without landing on a sign-in page (page-probe
// sessionState). The cookie count (--min-cookies) is only a pre-check. A proven login replaces
// the storage-state file, `requeue --gaps` runs, and the walk resumes. It never types credentials.
// Before each poll it nudges the window (nudgeSignIn): it opens --check-url there, which renews an
// SSO session that is still valid, and presses a lone "Sign in" / "Log in" / "Continue" button
// when no empty password field is on the page. A page that wants a password still waits for the
// human. --no-nudge turns this off.
//
// Exits: 0 frontier empty · 3 no sign-in within --max-wait · 4 scope coverage (explore's exit 4)
//        5 stalled (three chunks in a row closed no node) · any other code an explore failed with twice.
//
// No --workers: store.mjs rewrites graph.json whole from each process's in-memory copy, with no
// lock, so two explores on one graph dir lose each other's nodes. Parallel walks use one
// supervise per worker copy (`O fork`, then `--dir <copy> --only-prefix /area`) and `O merge` after. It writes
// <dir>/supervise.pid while it runs (walk-lock.mjs).

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DISCOVERY, playwright } from "../lib/pw.mjs";
import { Graph } from "./graph.mjs";
import { sessionState } from "./page-probe.mjs";
import { markSupervise } from "./walk-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, "run.mjs");
const EXPORT = join(dirname(here), "lib", "export-login.mjs");
const DONE = new Set(["closed", "gap", "bounded", "built", "verified"]);
// Flags supervise owns; every other flag goes to explore unchanged.
const OWN = { chunk: 1, poll: 1, "min-cookies": 1, "max-wait": 1, state: 1, "login-cdp": 1, domain: 1, "check-url": 1, workers: 1, "relogin-wait": 1 };

export function parse(argv) {
  const own = {};
  const pass = [];
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && (m[1] === "no-login" || m[1] === "no-nudge")) own[m[1]] = true;
    else if (m && OWN[m[1]]) own[m[1]] = m[2] ?? argv[++i];
    else pass.push(argv[i]);
  }
  const flag = (name) => {
    const i = pass.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return i < 0 ? undefined : pass[i].includes("=") ? pass[i].split("=").slice(1).join("=") : pass[i + 1];
  };
  return { own, pass, dir: flag("dir") ?? DISCOVERY, loginPattern: flag("login-pattern"), maxNodes: flag("max-nodes") };
}

/** Counts read fresh from graph.json: the frontier, and how many nodes left it for good. */
export function counts(dir) {
  const p = join(dir, "graph.json");
  if (!existsSync(p)) return { frontier: 0, done: 0, meta: {} };
  const g = new Graph(JSON.parse(readFileSync(p, "utf8")));
  const nodes = Object.values(g.data.nodes);
  return { frontier: nodes.filter((n) => n.status === "frontier" || n.status === "expanding").length, done: nodes.filter((n) => DONE.has(n.status)).length, meta: g.data.meta };
}

function run(args, { env, onLine = () => {} } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      for (const l of String(d).split("\n").filter(Boolean)) onLine(l);
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("close", (code, signal) => res({ code: code ?? (signal ? 128 : 1), out, err }));
  });
}

/**
 * Is the login in `stateFile` alive? Cheap pre-check first (cookie count), then the proof: a
 * headless page with that storage state opens `url` and must not be a sign-in page or a
 * session-ended notice. Returns { valid, why }.
 */
export async function checkLogin(stateFile, { url, minCookies = 1, loginPattern = null } = {}) {
  let n = 0;
  try {
    n = JSON.parse(readFileSync(stateFile, "utf8")).cookies?.length ?? 0;
  } catch (e) {
    return { valid: false, why: `unreadable storage state (${e.message})` };
  }
  if (n < minCookies) return { valid: false, why: `${n} cookie(s), fewer than --min-cookies ${minCookies}` };
  const { chromium } = await playwright();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: stateFile, serviceWorkers: "block" });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const st = await page.evaluate(sessionState, { loginSrc: loginPattern });
    if (st.login || st.ended || st.transient) return { valid: false, why: `${st.why} at ${st.href}` };
    return { valid: true, why: `reached ${st.href}` };
  } catch (e) {
    return { valid: false, why: e.message.split("\n")[0] };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * The loop. Every effect is a parameter so the stop rules can be tested without a browser:
 * runChunk() -> { code, err }, waitForLogin() -> true once signed in (false on --max-wait),
 * requeue() after a sign-in.
 */
export async function supervise({ dir, runChunk, waitForLogin, requeue, log, stallLimit = 3 }) {
  let stalls = 0;
  let failed = null;
  for (let chunk = 1; ; chunk++) {
    const before = counts(dir);
    if (before.frontier === 0) {
      log(`DONE frontier 0 (${before.done} node(s) closed)`);
      return { code: 0, reason: "frontier 0" };
    }
    const r = await runChunk(chunk);
    const after = counts(dir);
    const closed = after.done - before.done;
    log(`chunk ${chunk} exit ${r.code} · closed ${closed} · frontier ${after.frontier}`);
    if (r.code === 3) {
      stalls = 0;
      failed = null;
      if (!(await waitForLogin())) return { code: 3, reason: "no sign-in within --max-wait" };
      await requeue();
      continue;
    }
    if (r.code === 4) {
      log("STOPPED scope coverage (explore exit 4): fix the scope map, then supervise again");
      return { code: 4, reason: "scope coverage" };
    }
    if (r.code !== 0) {
      const why = `explore exit ${r.code}: ${(r.err ?? "").trim().split("\n").slice(-3).join(" | ") || "no output"}`;
      if (failed) {
        log(`STOPPED ${why} (failed twice in a row)`);
        return { code: r.code, reason: why };
      }
      failed = why;
      log(`RETRY once after ${why}`);
      continue;
    }
    failed = null;
    if (after.frontier === 0) continue;
    stalls = closed > 0 ? 0 : stalls + 1;
    if (stalls >= stallLimit) {
      const why = `stalled: ${stalls} chunks in a row closed 0 nodes with ${after.frontier} on the frontier`;
      log(`STOPPED ${why}`);
      return { code: 5, reason: why };
    }
  }
}

const SIGN_IN = /^\s*(sign\s*in|log\s*in|login|continue)(\s+again)?\s*$/i;

// One nudge on the human's window: open the check URL, then press a credential-free sign-in
// button if one is there. Returns what it did, for the log. Never fills any field.
export async function nudgeSignIn(page, url, { settleMs = 8000 } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(settleMs);
  const emptyPassword = await page.$$eval("input[type=password]", (els) => els.some((e) => e.offsetParent && !e.value)).catch(() => false);
  if (emptyPassword) return "opened; password needed (left to the human)";
  for (const b of await page.$$("button, input[type=submit], a[role=button]")) {
    const label = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || "").trim();
    if (SIGN_IN.test(label) && (await b.isVisible().catch(() => false))) {
      await b.click().catch(() => {});
      await page.waitForTimeout(settleMs);
      return `opened; pressed "${label}"`;
    }
  }
  return "opened";
}

async function nudgeWindow(cdp, url) {
  const { chromium } = await playwright();
  const browser = await chromium.connectOverCDP(cdp);
  try {
    const ctx = browser.contexts()[0];
    const site = new URL(url).hostname.split(".").slice(-2).join(".");
    const page = ctx.pages().find((p) => p.url().includes(site)) ?? ctx.pages()[0] ?? (await ctx.newPage());
    return await nudgeSignIn(page, url);
  } finally {
    await browser.close().catch(() => {}); // over CDP this detaches; the human's window stays open
  }
}

export async function main(argv) {
  const { own, pass, dir, loginPattern, maxNodes } = parse(argv);
  if (own.workers !== undefined) throw new Error("--workers is not supported: store.mjs rewrites graph.json whole with no lock or merge, so concurrent explores on one dir lose nodes. Run one supervise per dir copy (--dir <copy> --only-prefix /area).");
  const stateFile = own.state ?? process.env.SEEMLY_STORAGE_STATE;
  // An app with no login (a local clone) runs with --no-login: a lost session then stops the run.
  const noLogin = own["no-login"] !== undefined;
  if (!stateFile && !noLogin) throw new Error("supervise needs a saved login (--state <file> or SEEMLY_STORAGE_STATE), or --no-login for an app without one");
  const meta = counts(dir).meta;
  if (!meta.origin) throw new Error("run init first");
  const chunk = own.chunk ?? maxNodes ?? "25";
  const poll = +(own.poll ?? 30) * 1000;
  const maxWait = own["max-wait"] ? +own["max-wait"] * 60_000 : Infinity;
  const minCookies = +(own["min-cookies"] ?? 1);
  const loginCdp = own["login-cdp"] ?? "http://127.0.0.1:9222";
  const domain = own.domain ?? new URL(meta.origin).hostname;
  const checkUrl = own["check-url"] ?? meta.target ?? meta.origin;
  const logPath = join(dir, "supervise.log");
  const log = (s) => {
    const line = `${new Date().toISOString()} ${s}`;
    appendFileSync(logPath, line + "\n");
    console.log(s);
  };
  const explorePass = pass.filter((a, i) => !(a === "--max-nodes" || a.startsWith("--max-nodes=") || (i > 0 && pass[i - 1] === "--max-nodes")));
  if (own["relogin-wait"] !== undefined) log("note: --relogin-wait ignored; supervise waits for the sign-in itself");
  // supervise.pid for the whole run (idle between chunks too), so `O relabel` never rewrites the
  // dir under it; each chunk's explore knows it is this supervise's own (walk-lock.mjs).
  markSupervise(dir);
  const env = { ...(stateFile ? { SEEMLY_STORAGE_STATE: stateFile } : {}), SEEMLY_AGENT: process.env.SEEMLY_AGENT ?? "supervise", SEEMLY_SUPERVISE_PID: String(process.pid) };

  const runChunk = (n) =>
    run([RUN, "explore", "--dir", dir, ...explorePass.filter((a, i) => !(a === "--dir" || (i > 0 && explorePass[i - 1] === "--dir"))), "--max-nodes", String(chunk)], {
      env,
      onLine: (l) => appendFileSync(logPath, `  [chunk ${n}] ${l}\n`),
    });

  const waitForLogin = async () => {
    if (!stateFile) { log("session lost on an app run with --no-login: nothing to wait for"); return false; }
    const since = new Date().toISOString();
    log(`WAITING FOR SIGN-IN since ${since}`);
    const deadline = Date.now() + maxWait;
    const candidate = `${stateFile}.candidate`;
    let last = "";
    for (;;) {
      if (!own["no-nudge"]) {
        const did = await nudgeWindow(loginCdp, checkUrl).catch((e) => `nudge failed: ${e.message}`);
        appendFileSync(logPath, `  nudge: ${did}\n`);
      }
      // A fresh copy out of the human's window first; then the file as it stands (someone may
      // have run export-login by hand). Either one counts only once a real page proves it.
      const ex = await run([EXPORT, "--cdp", loginCdp, "--domain", domain, "--out", candidate]);
      for (const file of ex.code === 0 ? [candidate, stateFile] : [stateFile]) {
        const c = await checkLogin(file, { url: checkUrl, minCookies, loginPattern });
        if (c.valid) {
          if (file === candidate) renameSync(candidate, stateFile);
          log(`SIGNED IN (${c.why}); waited since ${since}; requeue --gaps and resume`);
          return true;
        }
        const why = `${file === candidate ? "window" : "saved file"}: ${c.why}`;
        if (why !== last) appendFileSync(logPath, `  still signed out: ${why}${ex.code ? `; export-login exit ${ex.code}` : ""}\n`);
        last = why;
      }
      if (existsSync(candidate)) rmSync(candidate);
      if (Date.now() + poll > deadline) {
        log(`STOPPED no sign-in within --max-wait (waiting since ${since})`);
        return false;
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  };
  const requeue = async () => {
    const r = await run([RUN, "requeue", "--gaps", "--dir", dir], { env });
    appendFileSync(logPath, r.out.split("\n").filter(Boolean).map((l) => `  [requeue] ${l}\n`).join(""));
  };

  log(`supervise ${dir}: chunks of ${chunk}, poll ${poll / 1000}s, login check ${checkUrl}`);
  const r = await supervise({ dir, runChunk, waitForLogin, requeue, log });
  return r.code;
}
