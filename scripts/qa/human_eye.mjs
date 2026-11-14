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
import { deadControls, inspect, reloadTo, unnamed } from "./human_eye_lib.mjs";
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
    if (o["dead-controls"]) f.push(...(await deadControls(page, { reset: reloadTo(url) })));
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
