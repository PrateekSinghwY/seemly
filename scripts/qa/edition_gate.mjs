#!/usr/bin/env node
// edition_gate: before any capture, prove the Playwright profile sees the same reference the
// human's Chrome sees: same host after redirects, same edition, same login state, same theme
// and language. A capture taken on the wrong edition or logged out looks fine and is wrong
// everywhere; one build lost a day to it. Seconds.
//
//   node edition_gate.mjs --url <reference url> [--host <expected host>] [--logged-in "<css or text=...>"]
//                         [--theme light|dark] [--lang en] [--cdp <url>] [--chrome '<json from the probe>']
//
// It prints a one-line Chrome probe. Run it with Claude in Chrome's javascript tool on the
// same URL and pass the JSON back with --chrome: the gate then fails on any field that differs.

import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { openReference, settle } from "../lib/pw.mjs";

const { values: o } = parseArgs({
  options: {
    url: { type: "string" }, host: { type: "string" }, "logged-in": { type: "string" }, theme: { type: "string" },
    lang: { type: "string" }, cdp: { type: "string" }, chrome: { type: "string" },
  },
});
if (!o.url) throw new Error("give --url <reference url>");

/** In-page; also printed for Chrome, so it must stay self-contained. */
function reading(loggedIn) {
  const has = (m) => {
    if (!m) return null;
    if (m.startsWith("text=")) return document.body.innerText.toLowerCase().includes(m.slice(5).toLowerCase());
    try {
      return !!document.querySelector(m);
    } catch {
      return null;
    }
  };
  const stored = (() => {
    try {
      return Object.keys(localStorage).filter((k) => /theme|mode|color/i.test(k)).map((k) => `${k}=${String(localStorage.getItem(k)).slice(0, 20)}`).sort().join(";");
    } catch {
      return "";
    }
  })();
  const root = document.documentElement;
  // The first opaque background from body up; a page that paints none shows the white canvas.
  const bg = [document.body, root]
    .map((el) => getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [])
    .find((c) => c.length >= 3 && (c.length < 4 || c[3] > 0))?.slice(0, 3) ?? [255, 255, 255];
  return {
    host: location.host,
    path: location.pathname,
    title: document.title.replace(/\d+/g, "#").slice(0, 80),
    lang: root.lang || navigator.language,
    theme: /dark/i.test(`${root.className} ${root.dataset.theme ?? ""} ${root.getAttribute("data-color-mode") ?? ""}`) || bg.reduce((a, b) => a + b, 0) < 200 ? "dark" : "light",
    themeStore: stored,
    loggedIn: has(loggedIn),
  };
}

const ref = await openReference({ cdp: o.cdp, isolate: true });
const page = await ref.context.newPage();
let pw;
try {
  await page.goto(o.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(page);
  pw = await page.evaluate(reading, o["logged-in"] ?? null);
} finally {
  await page.close().catch(() => {});
  await ref.close();
}

const fails = [];
if (o.host && pw.host !== o.host) fails.push(`host ${pw.host}, expected ${o.host}`);
if (o.theme && pw.theme !== o.theme) fails.push(`theme ${pw.theme}, expected ${o.theme} (a UI kit may keep it in localStorage: ${pw.themeStore || "none"})`);
if (o.lang && !pw.lang.startsWith(o.lang)) fails.push(`lang ${pw.lang}, expected ${o.lang}`);
if (o["logged-in"] && pw.loggedIn !== true) fails.push(`logged-in marker "${o["logged-in"]}" not found: the profile is logged out or on another account`);
if (o.chrome) {
  const ch = JSON.parse(o.chrome);
  const keys = ["host", "path", "title", "lang", "theme", ...(o["logged-in"] ? ["loggedIn"] : [])];
  for (const k of keys) if (JSON.stringify(ch[k]) !== JSON.stringify(pw[k])) fails.push(`${k}: Chrome ${JSON.stringify(ch[k])}, Playwright ${JSON.stringify(pw[k])}`);
}

console.log(`PLAYWRIGHT ${JSON.stringify(pw)}`);
if (!o.chrome) console.log(`CHROME PROBE (run on ${o.url}, pass the result back with --chrome):\n(${reading.toString()})(${JSON.stringify(o["logged-in"] ?? null)})`);
for (const f of fails) console.log(`✗ ${f}`);
console.log(fails.length ? "EDITION GATE FAILED" : `EDITION GATE ${o.chrome ? "PASSED (both tools)" : "PASSED (Playwright side; compare with Chrome)"}`);
writeCheckRecord("edition_gate", { ran: true, count: o.chrome ? 2 : 1, status: fails.length ? "fail" : "pass", reason: fails.join("; ") || null });
process.exitCode = fails.length ? 1 : 0;

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
