#!/usr/bin/env node
// Record a person driving the reference by hand: every click, every page and state they reach,
// and every API call with its request and response body, writes included. This is the capture
// for what the explorer will not fire on its own (approve, submit, sign off, settings changes)
// and the only way to get a write's real request shape. The person drives; nothing is clicked
// or typed by the tool, and it never sees a password (log in first, then export-login).
//
//   SEEMLY_STORAGE_STATE=never_to_be_pushed/discovery/auth-manager.json \
//   node record-session.mjs --name approve-request [--role manager] [--start <url>] [--origin <url>]
//
// Writes never_to_be_pushed/discovery/sessions/<role>/<name>-<stamp>/:
//   session.jsonl   one row per step and per API call, in order
//   steps/<nnn>/    screenshot.png, aria.yml, dom.html after each step settles
//   api/<nnn>.*     request and response bodies (JSON or text, 2 MB cap)
//   flow.md         the flow as read back: step -> the calls it caused (method, path, status)
// Close the window (or Ctrl-C) to finish. Everything lands under never_to_be_pushed/: it can hold
// personal data from the reference and is never committed.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DISCOVERY, openReference } from "../lib/pw.mjs";

const { values: o } = parseArgs({
  options: {
    name: { type: "string" },
    role: { type: "string", default: "default" },
    start: { type: "string" },
    origin: { type: "string" },
    settle: { type: "string", default: "1500" },
    // Smoke tests only: no window, stop after N seconds.
    headless: { type: "boolean", default: false },
    for: { type: "string" },
    "test-click": { type: "string", multiple: true, default: [] },
  },
});
if (!o.name) throw new Error("give --name <flow-name> (e.g. approve-request)");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(DISCOVERY, "sessions", o.role, `${o.name}-${stamp}`);
mkdirSync(join(out, "steps"), { recursive: true });
mkdirSync(join(out, "api"), { recursive: true });
const log = (row) => appendFileSync(join(out, "session.jsonl"), JSON.stringify({ t: Date.now(), ...row }) + "\n");

// Only the app's own calls: same origin as the start page unless --origin says otherwise.
let origin = o.origin ? new URL(o.origin).origin : o.start ? new URL(o.start).origin : null;
const ours = (url) => !origin || url.startsWith(origin);
const STATIC = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;

const { context, close } = await openReference({ headed: !o.headless });
const page = context.pages()[0] ?? (await context.newPage());

let step = 0;
let apiSeq = 0;
const calls = []; // { action, method, path, status }
// Calls are tied to the action that caused them (the last click, change or navigation).
const actions = [{ n: 0, what: "open" }];
let snapTimer = null;

async function snapshot(kind, detail) {
  const n = String(++step).padStart(3, "0");
  const dir = join(out, "steps", n);
  mkdirSync(dir, { recursive: true });
  log({ type: "step", step: n, kind, detail, url: page.url() });
  await page.screenshot({ path: join(dir, "screenshot.png"), timeout: 15000 }).catch(() => {});
  writeFileSync(join(dir, "aria.yml"), await page.locator("body").ariaSnapshot({ timeout: 15000 }).catch(() => ""));
  writeFileSync(join(dir, "dom.html"), await page.content().catch(() => ""));
  console.log(`step ${n} ${kind} ${detail ?? ""} ${page.url()}`);
}
// A click is read after the app has answered it, not at the click.
function later(kind, detail) {
  clearTimeout(snapTimer);
  snapTimer = setTimeout(() => snapshot(kind, detail).catch(() => {}), +o.settle);
}

await context.exposeBinding("__seemlyAction", (_src, a) => {
  actions.push({ n: actions.length, what: `${a.kind} ${a.role} "${a.name}"${a.field ? ` [${a.field}]` : ""}` });
  log({ type: "action", n: actions.length - 1, ...a });
  later(a.kind, `${a.role} "${a.name}"`);
});
await context.addInitScript(() => {
  const describe = (t) => {
    const el = t.closest?.("button,a,[role],input,select,textarea,label,summary,[tabindex]") ?? t;
    const role = el.getAttribute?.("role") || el.tagName?.toLowerCase() || "?";
    const name = (el.getAttribute?.("aria-label") || el.innerText || el.value || el.title || el.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 80);
    return { role, name };
  };
  addEventListener("click", (e) => window.__seemlyAction?.({ kind: "click", ...describe(e.target) }), true);
  addEventListener("change", (e) => {
    const t = e.target;
    // Field identity only; the typed value is never recorded (it can be personal or a secret).
    if (t?.type === "password") return;
    window.__seemlyAction?.({ kind: "change", ...describe(t), field: t?.name || t?.id || t?.getAttribute?.("aria-label") || "" });
  }, true);
  addEventListener("keydown", (e) => { if (e.key === "Enter") window.__seemlyAction?.({ kind: "enter", ...describe(e.target) }); }, true);
});

page.on("framenavigated", (f) => {
  if (f !== page.mainFrame()) return;
  if (!/^https?:/.test(f.url())) return;
  actions.push({ n: actions.length, what: `navigate ${new URL(f.url()).pathname}` });
  later("navigate", "");
});
page.on("response", async (res) => {
  const req = res.request();
  if (!["xhr", "fetch"].includes(req.resourceType()) || STATIC.test(res.url()) || !ours(res.url())) return;
  const n = String(++apiSeq).padStart(4, "0");
  const ctype = res.headers()["content-type"] ?? "";
  const ext = /json/.test(ctype) ? "json" : "txt";
  const reqBody = req.postData();
  if (reqBody) writeFileSync(join(out, "api", `${n}.req.${/^\s*[[{]/.test(reqBody) ? "json" : "txt"}`), reqBody.slice(0, 2_000_000));
  const body = await Promise.race([res.text().catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
  if (body !== null) writeFileSync(join(out, "api", `${n}.res.${ext}`), body.slice(0, 2_000_000));
  const path = new URL(res.url()).pathname;
  calls.push({ action: actions.length - 1, method: req.method(), path, status: res.status() });
  // Headers are not recorded: they carry the session.
  log({ type: "api", seq: n, action: actions.length - 1, method: req.method(), url: res.url(), status: res.status(), ctype, hasReq: Boolean(reqBody) });
});

if (o.start) {
  await page.goto(o.start, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  origin ??= new URL(page.url()).origin;
}
for (const sel of o["test-click"]) {
  await page.waitForTimeout(800);
  await page.locator(sel).first().click({ timeout: 5000 }).catch((e) => console.error(`test-click ${sel}: ${e.message.split("\n")[0]}`));
}
console.log(`RECORDING ${o.role}/${o.name} -> ${out}\nDrive the flow in the window. Close the window (or Ctrl-C) when done.`);

let finished = false;
async function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(snapTimer);
  const lines = [`# ${o.role}: ${o.name}`, "", `${actions.length - 1} actions, ${step} snapshots, ${calls.length} API calls (${calls.filter((c) => c.method !== "GET").length} non-GET)`, ""];
  for (const a of actions) {
    const cs = calls.filter((c) => c.action === a.n);
    lines.push(`${a.n}. ${a.what}`);
    for (const c of cs) lines.push(`   - ${c.method} ${c.path} -> ${c.status}`);
  }
  writeFileSync(join(out, "flow.md"), lines.join("\n"));
  console.log(`saved ${out}/flow.md`);
  await close().catch(() => {});
  process.exit(0);
}
process.once("SIGINT", finish);
if (o.for) setTimeout(finish, +o.for * 1000);
page.on("close", finish);
await new Promise(() => {});
