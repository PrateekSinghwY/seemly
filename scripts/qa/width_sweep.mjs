#!/usr/bin/env node
// width_sweep: the structural audit at every width a person might use, plus N-1 / N / N+1 at
// each breakpoint, because a build checked only at 1440 shipped overflow at 1024 and a
// left-pinned layout at 1680+. Saves a screenshot pair per width for a human glance.
//
// Costs two page loads per width per pair (about 20 s a page with the defaults), so it runs
// when a page is finished (PAGE COMPLETE) and in QA, not after every edit.
//
//   node width_sweep.mjs --ref <url> --clone <url> [--breakpoints 1024,1280] [--widths 1024,1440,...]
//   node width_sweep.mjs --pairs pairs.json [--allow allow.json] [--cdp <url>]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { DISCOVERY, openClone, openReference, settle } from "../lib/pw.mjs";
import { allowFrom, diffLabels, pairsFrom, readLabels, slug } from "./labels.mjs";

export const DEFAULT_WIDTHS = [1024, 1280, 1366, 1440, 1536, 1680, 1920, 2560];

const { values: o } = parseArgs({
  options: {
    ref: { type: "string" }, clone: { type: "string" }, pairs: { type: "string" }, allow: { type: "string" },
    widths: { type: "string" }, breakpoints: { type: "string" }, height: { type: "string", default: "900" }, cdp: { type: "string" },
  },
});

const widths = new Set(o.widths ? o.widths.split(",").map(Number) : DEFAULT_WIDTHS);
for (const b of (o.breakpoints ?? "").split(",").filter(Boolean).map(Number)) for (const w of [b - 1, b, b + 1]) widths.add(w);
const sorted = [...widths].sort((a, b) => a - b);
const pairs = await pairsFrom(o);
const allow = await allowFrom(o.allow);

const ref = await openReference({ cdp: o.cdp, isolate: true });
const clone = await openClone();
const rp = await ref.context.newPage();
const cp = await clone.context.newPage();
let failing = 0;
let checked = 0;
try {
  for (const p of pairs) {
    const dir = join(DISCOVERY, "qa", "widths", slug(p.clone));
    mkdirSync(dir, { recursive: true });
    const rows = [];
    for (const w of sorted) {
      const viewport = { width: w, height: +o.height };
      await Promise.all([rp.setViewportSize(viewport), cp.setViewportSize(viewport)]);
      await rp.goto(p.ref, { waitUntil: "domcontentloaded", timeout: 45000 });
      await cp.goto(p.clone, { waitUntil: "domcontentloaded", timeout: 45000 });
      await Promise.all([settle(rp), settle(cp)]);
      const d = diffLabels(await rp.evaluate(readLabels), await cp.evaluate(readLabels), allow);
      await rp.screenshot({ path: join(dir, `${w}-ref.png`) }).catch(() => {});
      await cp.screenshot({ path: join(dir, `${w}-clone.png`) }).catch(() => {});
      rows.push({ width: w, diff: d });
      checked++;
      const bad = Object.keys(d);
      if (bad.length) failing++;
      console.log(`${bad.length ? "✗" : "✓"} ${p.clone} @${w}${bad.length ? `  ${bad.map((c) => (c === "overflowX" ? `overflow ref=${d[c].ref} clone=${d[c].clone}` : `${c}: -${d[c].missing.length} +${d[c].extra.length}${d[c].order ? " order" : ""}`)).join(", ")}` : ""}`);
    }
    writeFileSync(join(dir, "report.json"), JSON.stringify({ pair: p, rows }, null, 1));
  }
} finally {
  await rp.close().catch(() => {});
  await ref.close();
  await clone.close();
}
writeCheckRecord("width_sweep", { ran: true, count: checked, status: failing ? "fail" : "pass", reason: failing ? `${failing} of ${checked} page-width readings differ; screenshots under discovery/qa/widths/` : null });
process.exitCode = failing ? 1 : 0;

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
