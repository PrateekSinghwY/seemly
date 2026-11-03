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
//                 { "path": "/api/listings?limit=50", "contains": "Harbor Loft" }],
//     "page":    { "path": "/listings/12", "text": "Harbor Loft" },
//     "restore": { "method": "PATCH", "path": "/api/listings/12", "body": { "name": "Seaside Flat" } }
//   }]
// Every surface that reads the value belongs in `expect` (list, detail, counters): a write
// that lands on one surface and not the others is the fan-out defect this exists for.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { writeCheckRecord } from "../lib/check-record.mjs";
import { openClone, settle } from "../lib/pw.mjs";

const { values: o } = parseArgs({
  options: {
    spec: { type: "string" },
    api: { type: "string", default: process.env.CLONE_API ?? "http://127.0.0.1:8000" },
    web: { type: "string", default: process.env.CLONE_WEB ?? "http://127.0.0.1:3000" },
  },
});
if (!o.spec) throw new Error("give --spec <writes.json>");
const rows = JSON.parse(readFileSync(o.spec, "utf8"));

async function call(method, path, body) {
  const res = await fetch(new URL(path, o.api), { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

/** RFC 6901 pointer. */
function at(doc, pointer) {
  if (!pointer) return doc;
  return pointer.split("/").slice(1).reduce((v, k) => (v == null ? undefined : v[k.replace(/~1/g, "/").replace(/~0/g, "~")]), doc);
}

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
    for (const e of r.expect ?? []) {
      const g = await call("GET", e.path);
      if (g.status !== 200) bad(`read ${e.path} -> ${g.status}`);
      else if ("equals" in e && JSON.stringify(at(g.json, e.pointer)) !== JSON.stringify(e.equals)) bad(`read ${e.path}${e.pointer ?? ""} = ${JSON.stringify(at(g.json, e.pointer))}, wrote ${JSON.stringify(e.equals)}`);
      else if ("contains" in e && !g.text.includes(e.contains)) bad(`read ${e.path} does not contain "${e.contains}"`);
    }
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
