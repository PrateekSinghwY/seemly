#!/usr/bin/env node
// write_round_trip: a write control is done only when the endpoint accepts it, a read returns
// it, and the rendered page still shows it after a hard reload. A form that "saves" into
// component state passes every visual gate and fails this one. Seconds per write.
//
//   node write_roundtrip.mjs --spec writes.json [--api http://127.0.0.1:8000] [--web http://127.0.0.1:3000]
//
// writes.json: one row per write the clone exposes
//   [{
//     "name": "rename listing",
//     "write":   { "method": "PATCH", "path": "/api/listings/12", "body": { "name": "Harbor Loft" } },
//     "expect":  [{ "path": "/api/listings/12", "pointer": "/name", "equals": "Harbor Loft" },
//                 { "path": "/api/listings?limit=50", "contains": "Harbor Loft" },
//                 { "method": "POST", "path": "/api/listings/multi_read", "body": { "ids": [12] }, "contains": "Harbor Loft" }],
//     "page":    { "path": "/listings/12", "text": "Harbor Loft" },
//     "restore": { "method": "PATCH", "path": "/api/listings/12", "body": { "name": "Seaside Flat" } }
//   }]
// Every surface that reads the value belongs in `expect` (list, detail, counters): a write
// that lands on one surface and not the others is the fan-out defect this exists for.
// An `expect` row is a read request: GET by default, or `method` + `body` for a read POST
// (multi_read, search); a non-GET read-back is sent only when the request classifier calls it a
// read, or an --allow-post regex names it (roundtrip_lib.mjs).
//
//   [--allow-post <regex>]...   read-back POSTs the classifier cannot name as reads

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { openClone, settle } from "../lib/pw.mjs";
import { caller, checkExpect } from "./roundtrip_lib.mjs";

const { values: o } = parseArgs({
  options: {
    spec: { type: "string" },
    api: { type: "string", default: process.env.CLONE_API ?? "http://127.0.0.1:8000" },
    web: { type: "string", default: process.env.CLONE_WEB ?? "http://127.0.0.1:3000" },
    "allow-post": { type: "string", multiple: true, default: [] },
  },
});
const allowPost = o["allow-post"].map((r) => new RegExp(r));
if (!o.spec) throw new Error("give --spec <writes.json>");
const rows = JSON.parse(readFileSync(o.spec, "utf8"));

const call = caller(o.api);

const fails = [];
const clone = await openClone();
try {
  for (const r of rows) {
    const bad = (why) => fails.push(`${r.name}: ${why}`);
    const w = await call(r.write.method, r.write.path, r.write.body);
    if (w.status < 200 || w.status >= 300) {
      bad(`write ${r.write.method} ${r.write.path} -> ${w.status} ${w.text.slice(0, 120)}`);
      continue;
    }
    for (const e of [r.expect ?? []].flat()) for (const f of await checkExpect(e, call, { api: o.api, allowPost })) bad(f);
    if (r.page) {
      for (const pass of ["load", "hard reload"]) {
        const page = await clone.context.newPage();
        await page.goto(new URL(r.page.path, o.web).href, { waitUntil: "domcontentloaded" });
        await settle(page);
        const seen = await page.getByText(r.page.text, { exact: false }).first().isVisible().catch(() => false);
        if (!seen) bad(`page ${r.page.path} does not show "${r.page.text}" after ${pass}`);
        await page.close();
      }
    }
    if (r.restore) {
      const x = await call(r.restore.method, r.restore.path, r.restore.body);
      if (x.status < 200 || x.status >= 300) bad(`restore -> ${x.status}`);
    }
    console.log(`${fails.some((f) => f.startsWith(`${r.name}:`)) ? "✗" : "✓"} ${r.name}`);
  }
} finally {
  await clone.close();
}
for (const f of fails) console.log(`    ${f}`);
writeCheckRecord("write_round_trip", { ran: true, count: rows.length, status: fails.length ? "fail" : "pass", reason: fails.length ? `${fails.length} failure(s)` : null });
process.exitCode = fails.length ? 1 : 0;

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
