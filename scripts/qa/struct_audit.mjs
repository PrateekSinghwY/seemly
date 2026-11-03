#!/usr/bin/env node
// structure_labels: the clone's structural labels equal the reference's, at one width.
// An invented tab, a missing column header or a nav item added by hand fails it, at the cost of
// two page loads per pair. The pixel diff cannot see these when the region is masked or the
// item sits off the oracle's crop.
//
//   node struct_audit.mjs --ref <url> --clone <url> [--width 1440] [--allow allow.json] [--cdp <url>]
//   node struct_audit.mjs --pairs pairs.json ...          pairs.json: [{ "ref": .., "clone": .. }]
//   allow.json: [{ "category": "buttons", "label": "Chat", "reason": "disabled per ruling, see KNOWN_GAPS" }]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { DISCOVERY, openClone, openReference, settle } from "../lib/pw.mjs";
import { CATEGORIES, allowFrom, diffLabels, pairsFrom, readLabels, slug } from "./labels.mjs";

const { values: o } = parseArgs({
  options: {
    ref: { type: "string" }, clone: { type: "string" }, pairs: { type: "string" }, allow: { type: "string" },
    width: { type: "string", default: "1440" }, height: { type: "string", default: "900" }, cdp: { type: "string" },
  },
});

const pairs = await pairsFrom(o);
const allow = await allowFrom(o.allow);
const viewport = { width: +o.width, height: +o.height };
const ref = await openReference({ cdp: o.cdp, viewport, isolate: true });
const clone = await openClone({ viewport });
const rp = await ref.context.newPage();
const cp = await clone.context.newPage();
await rp.setViewportSize(viewport);

const outDir = join(DISCOVERY, "qa", "struct");
mkdirSync(outDir, { recursive: true });
let failing = 0;
try {
  for (const p of pairs) {
    await rp.goto(p.ref, { waitUntil: "domcontentloaded", timeout: 45000 });
    await cp.goto(p.clone, { waitUntil: "domcontentloaded", timeout: 45000 });
    await Promise.all([settle(rp), settle(cp)]);
    const a = await rp.evaluate(readLabels);
    const b = await cp.evaluate(readLabels);
    const d = diffLabels(a, b, allow);
    writeFileSync(join(outDir, `${slug(p.clone)}-${o.width}.json`), JSON.stringify({ pair: p, width: +o.width, ref: a, clone: b, diff: d }, null, 1));
    const bad = Object.keys(d);
    if (bad.length) failing++;
    console.log(`${bad.length ? "✗" : "✓"} ${p.clone} @${o.width}`);
    for (const c of bad) {
      const x = d[c];
      if (c === "overflowX") console.log(`    horizontal overflow: ref ${x.ref}, clone ${x.clone}`);
      else console.log(`    ${c}: ${x.missing.length ? `missing [${x.missing.join(" | ")}] ` : ""}${x.extra.length ? `invented [${x.extra.join(" | ")}] ` : ""}${x.order ? "same labels, different order" : ""}`);
    }
  }
} finally {
  await rp.close().catch(() => {});
  await ref.close();
  await clone.close();
}
writeCheckRecord("structure_labels", { ran: true, count: pairs.length, status: failing ? "fail" : "pass", reason: failing ? `${failing} of ${pairs.length} page(s) differ in ${CATEGORIES.join("/")}` : null });
process.exitCode = failing ? 1 : 0;

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
