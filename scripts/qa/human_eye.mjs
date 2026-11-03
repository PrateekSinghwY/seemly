#!/usr/bin/env node
// human_eye_qa + distinct_images: what a person notices in the first ten seconds that the
// pixel, style and structure gates do not, on the CLONE's rendered pages:
//
//   stand-in images   one image file shown for different things (two teams, one crest)
//   broken images     loaded with no pixels
//   clipped text      cut off by overflow with no ellipsis, sideways or by line height
//   unnamed controls  a button, link or field with no accessible name (from the AX tree)
//   page overflow     the document scrolls sideways
//   dead controls     (--dead-controls) an enabled control that does nothing when clicked:
//                     no DOM change, no navigation, no request in a second. Writes are aborted
//                     so the sweep cannot dirty the clone's DB.
//
// Seconds per page without --dead-controls; with it, a reload per control, so run that at
// slice end, not per edit.
//
//   node human_eye.mjs --url <clone url> [--url <another>] [--dead-controls] [--allow allow.json]
//   allow.json: [{ "kind": "clipped", "match": "tbody td", "reason": "reference clips here too" }]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { DISCOVERY, openClone, settle } from "../lib/pw.mjs";
import { slug } from "./labels.mjs";

const { values: o } = parseArgs({
  options: {
    url: { type: "string", multiple: true, default: [] },
    "dead-controls": { type: "boolean", default: false },
    allow: { type: "string" },
    width: { type: "string", default: "1440" },
  },
});
if (!o.url.length) throw new Error("give at least one --url <clone page>");
const allow = o.allow ? JSON.parse(readFileSync(o.allow, "utf8")) : [];
for (const a of allow) if (!a.reason) throw new Error(`allow entry ${a.kind} ${a.match} has no reason`);
const allowed = (f) => allow.some((a) => a.kind === f.kind && (f.where ?? "").includes(a.match));

function inspect() {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const where = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.classList[0] ? `.${e.classList[0]}` : ""));
    return parts.join(" > ");
  };
  const findings = [];

  // Stand-in images: one src, several different things it stands for.
  const bySrc = new Map();
  for (const img of document.querySelectorAll("img")) {
    if (!visible(img)) continue;
    if (img.complete && img.naturalWidth === 0) {
      findings.push({ kind: "broken-image", where: where(img), detail: img.currentSrc || img.src });
      continue;
    }
    const src = img.currentSrc || img.src;
    if (!src || img.alt === "" && img.getAttribute("role") === "presentation") continue;
    const card = img.closest("article,li,tr,[class*=card],[class*=Card],[class*=item],[class*=Item]");
    const label = text(img.alt) || text(card?.querySelector("h1,h2,h3,h4,h5,h6,strong,a")?.innerText) || "";
    if (!label) continue;
    (bySrc.get(src) ?? bySrc.set(src, new Set()).get(src)).add(label);
  }
  for (const [src, labels] of bySrc) if (labels.size >= 2) findings.push({ kind: "stand-in-image", where: src, detail: `one image for ${labels.size} different things: ${[...labels].slice(0, 4).join(" / ")}` });

  // Clipped text.
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el) || !el.childNodes.length) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    // Visually hidden on purpose (screen-reader-only text): a 1px clipped box is not clipped text.
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1 || (cs.clip && cs.clip !== "auto") || /inset\(50%\)/.test(cs.clipPath)) continue;
    const hidesX = /hidden|clip/.test(cs.overflowX);
    const hidesY = /hidden|clip/.test(cs.overflowY);
    if (hidesX && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis") findings.push({ kind: "clipped", where: where(el), detail: `sideways, "${text(el.innerText, 40)}"` });
    else if (hidesY && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === "none") findings.push({ kind: "clipped", where: where(el), detail: `cut at the bottom, "${text(el.innerText, 40)}"` });
  }

  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) findings.push({ kind: "page-overflow", where: "html", detail: `${document.documentElement.scrollWidth}px wide in a ${document.documentElement.clientWidth}px viewport` });
  for (const a of document.querySelectorAll('a[href="#"],a[href=""],a[href^="javascript:void"]')) if (visible(a) && !a.getAttribute("role")) findings.push({ kind: "dead-link", where: where(a), detail: text(a.innerText) || "(no text)" });
  return findings;
}

const NAMED = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "slider", "spinbutton", "searchbox", "listbox", "option"]);

async function unnamed(page) {
  const cdp = await page.context().newCDPSession(page);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  await cdp.detach();
  return nodes
    .filter((n) => !n.ignored && NAMED.has(n.role?.value) && !(n.name?.value ?? "").trim())
    .map((n) => ({ kind: "unnamed-control", where: `${n.role.value} (backend node ${n.backendDOMNodeId})`, detail: "no accessible name" }));
}

/** Click each enabled control on a fresh load and watch for any effect for one second. */
async function deadControls(page, url) {
  const list = await page.evaluate(() => {
    const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
    return [...document.querySelectorAll("button:not([disabled]),[role=button]:not([aria-disabled=true]),[role=tab],[role=menuitem],a[href]")]
      .filter(visible)
      .map((el, i) => (el.dataset.seemlyDead = String(i), { i, name: (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50) }));
  });
  const found = [];
  for (const c of list) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page, 4000);
    await page.evaluate(() => document.querySelectorAll("button:not([disabled]),[role=button]:not([aria-disabled=true]),[role=tab],[role=menuitem],a[href]").forEach((el, i) => (el.dataset.seemlyDead = String(i))));
    let requests = 0;
    const onReq = () => requests++;
    page.on("request", onReq);
    await page.evaluate(() => {
      window.__seemlyMut = 0;
      new MutationObserver((m) => (window.__seemlyMut += m.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const before = page.url();
    await page.locator(`[data-seemly-dead="${c.i}"]`).first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
    page.off("request", onReq);
    const mutations = await page.evaluate(() => window.__seemlyMut ?? 0).catch(() => 1);
    if (!mutations && !requests && page.url() === before) found.push({ kind: "dead-control", where: `#${c.i}`, detail: `"${c.name || "(no name)"}" does nothing` });
  }
  return found;
}

const clone = await openClone({ viewport: { width: +o.width, height: 900 } });
await clone.context.route("**/*", (r) => (["GET", "HEAD", "OPTIONS"].includes(r.request().method()) ? r.fallback() : r.abort("blockedbyclient")));
const page = await clone.context.newPage();
const outDir = join(DISCOVERY, "qa", "human-eye");
mkdirSync(outDir, { recursive: true });
let total = 0;
let images = 0;
try {
  for (const url of o.url) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    let f = [...(await page.evaluate(inspect)), ...(await unnamed(page))];
    if (o["dead-controls"]) f.push(...(await deadControls(page, url)));
    f = f.filter((x) => !allowed(x));
    writeFileSync(join(outDir, `${slug(url)}.json`), JSON.stringify(f, null, 1));
    total += f.length;
    images += f.filter((x) => x.kind === "stand-in-image").length;
    console.log(`${f.length ? "✗" : "✓"} ${url}  ${f.length} finding(s)`);
    for (const x of f.slice(0, 40)) console.log(`    ${x.kind.padEnd(16)} ${x.detail}  [${x.where}]`);
    if (f.length > 40) console.log(`    ... ${f.length - 40} more in discovery/qa/human-eye/${slug(url)}.json`);
  }
} finally {
  await clone.close();
}
writeCheckRecord("human_eye_qa", { ran: true, count: o.url.length, status: total ? "fail" : "pass", reason: total ? `${total} finding(s)` : null });
writeCheckRecord("distinct_images", { ran: true, count: o.url.length, status: images ? "fail" : "pass", reason: images ? `${images} stand-in image(s)` : null });
process.exitCode = total ? 1 : 0;

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
