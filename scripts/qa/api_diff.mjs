#!/usr/bin/env node
// The reference's real API against the clone's OpenAPI: which endpoints the reference calls that
// the clone does not serve, and, for the ones both have, which request and response fields differ.
// Reads what the walker saved (nodes/*/inventory.json + xhr/) and what record-session saved
// (sessions/**/session.jsonl + api/). Network mirroring is a rule of the clone; this is its check.
//
//   node api_diff.mjs --ref never_to_be_pushed/discovery [--ref <more dirs>]... \
//        --openapi http://localhost:8000/api/openapi.json [--clone-prefix /api] [--ref-prefix ""] \
//        [--out never_to_be_pushed/discovery/api-diff.md]
//
// Paths are compared as templates: an id-like segment (digits, a uuid, a long hex or mixed token)
// and an OpenAPI {param} both become {id}. Field paths are flattened (`items[].person.id`) to depth
// 5. A candidate list like `compare`: confirm a line by hand before it goes in a report.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=.*\d)[A-Za-z0-9_-]{12,})$/i;

export function template(path, prefix = "") {
  let p = path.split("?")[0];
  if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length) || "/";
  return (
    p
      .split("/")
      .map((s) => (/^\{.+\}$/.test(s) || ID_SEG.test(s) ? "{id}" : s))
      .join("/")
      .replace(/\/+$/, "") || "/"
  );
}

/** Flattened key paths of a JSON value: `a.b`, `items[].c`. */
export function keyPaths(v, base = "", depth = 0, out = new Set()) {
  if (depth > 5 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const item of v.slice(0, 20)) keyPaths(item, `${base}[]`, depth + 1, out);
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    const p = base ? `${base}.${k}` : k;
    out.add(p);
    keyPaths(val, p, depth + 1, out);
  }
  return out;
}

/** Flattened property paths an OpenAPI schema allows (resolving $ref, allOf, anyOf, oneOf, items). */
export function schemaPaths(spec, schema, base = "", depth = 0, out = new Set(), seen = new Set()) {
  if (!schema || depth > 5) return out;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return out;
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], spec);
    return schemaPaths(spec, target, base, depth, out, new Set([...seen, schema.$ref]));
  }
  for (const k of ["allOf", "anyOf", "oneOf"]) for (const s of schema[k] ?? []) schemaPaths(spec, s, base, depth, out, seen);
  if (schema.items) schemaPaths(spec, schema.items, `${base}[]`, depth + 1, out, seen);
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const p = base ? `${base}.${k}` : k;
    out.add(p);
    schemaPaths(spec, s, p, depth + 1, out, seen);
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") out.add(`${base}.*`);
  return out;
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

function* walk(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p, depth + 1);
    else yield p;
  }
}

/** Every reference call the walker and the recorder saved: { method, url, res, req, where }. */
export function referenceCalls(dirs) {
  const calls = [];
  for (const root of dirs)
    for (const f of walk(root)) {
      if (f.endsWith("inventory.json")) {
        const inv = readJson(f);
        const xhr = join(f, "..", "xhr");
        for (const r of inv?.requests ?? [])
          calls.push({ method: r.method, url: r.url, status: r.status, res: r.file ? readJson(join(xhr, r.file)) : undefined, req: r.reqFile ? readJson(join(xhr, r.reqFile)) : undefined, where: `walk ${inv.id}` });
      } else if (f.endsWith("session.jsonl")) {
        const api = join(f, "..", "api");
        for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
          const row = JSON.parse(line);
          if (row.type !== "api") continue;
          calls.push({ method: row.method, url: row.url, status: row.status, res: readJson(join(api, `${row.seq}.res.json`)), req: readJson(join(api, `${row.seq}.req.json`)), where: `session ${f.split("/sessions/")[1]?.replace("/session.jsonl", "") ?? f}` });
        }
      }
    }
  return calls;
}

/** The clone's operations by `METHOD template`, with the field paths its schemas allow. */
export function cloneOps(spec, clonePrefix = "") {
  const ops = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {}))
    for (const [method, op] of Object.entries(item)) {
      if (!/^(get|post|put|patch|delete)$/.test(method)) continue;
      const ok = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code))?.[1];
      const resSchema = ok?.content?.["application/json"]?.schema;
      const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
      ops.set(`${method.toUpperCase()} ${template(path, clonePrefix)}`, {
        path,
        res: resSchema ? schemaPaths(spec, resSchema) : null,
        req: reqSchema ? schemaPaths(spec, reqSchema) : null,
      });
    }
  return ops;
}

export function diff(calls, ops, refPrefix = "") {
  const byKey = new Map();
  for (const c of calls) {
    let u;
    try {
      u = new URL(c.url);
    } catch {
      continue;
    }
    const key = `${c.method.toUpperCase()} ${template(u.pathname, refPrefix)}`;
    const e = byKey.get(key) ?? { key, count: 0, where: new Set(), res: new Set(), req: new Set(), statuses: new Set() };
    e.count++;
    e.where.add(c.where);
    e.statuses.add(c.status);
    if (c.res !== undefined) keyPaths(c.res, "", 0, e.res);
    if (c.req !== undefined) keyPaths(c.req, "", 0, e.req);
    byKey.set(key, e);
  }
  const missing = [];
  const matched = [];
  for (const e of [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const op = ops.get(e.key);
    if (!op) {
      missing.push(e);
      continue;
    }
    const allows = (set, p) => set.has(p) || [...set].some((s) => s.endsWith(".*") && p.startsWith(s.slice(0, -2)));
    matched.push({
      ...e,
      clonePath: op.path,
      resMissing: op.res ? [...e.res].filter((p) => !allows(op.res, p)) : [],
      reqMissing: op.req ? [...e.req].filter((p) => !allows(op.req, p)) : e.req.size ? [...e.req] : [],
      untypedRes: !op.res,
    });
  }
  return { missing, matched, refOps: byKey.size, cloneOps: ops.size };
}

export function toMarkdown(r) {
  const L = [];
  const drift = r.matched.filter((m) => m.resMissing.length || m.reqMissing.length);
  L.push("# API diff: reference calls vs clone OpenAPI", "");
  L.push(`- reference operations seen: **${r.refOps}**`);
  L.push(`- served by the clone: **${r.matched.length}** (${drift.length} with field differences)`);
  L.push(`- not served by the clone: **${r.missing.length}**`);
  L.push(`- clone operations in OpenAPI: ${r.cloneOps}`, "");
  L.push("## Not served by the clone", "", "| operation | calls | seen in |", "|---|---|---|");
  for (const m of r.missing) L.push(`| \`${m.key}\` | ${m.count} | ${[...m.where].slice(0, 3).join("; ")} |`);
  L.push("", "## Served, with field differences", "");
  for (const m of drift) {
    L.push(`### \`${m.key}\` (clone \`${m.clonePath}\`)`);
    if (m.reqMissing.length) L.push(`- request fields the clone does not accept: ${m.reqMissing.slice(0, 40).map((p) => `\`${p}\``).join(", ")}`);
    if (m.resMissing.length) L.push(`- response fields the clone does not return: ${m.resMissing.slice(0, 40).map((p) => `\`${p}\``).join(", ")}`);
    L.push("");
  }
  const untyped = r.matched.filter((m) => m.untypedRes);
  if (untyped.length) L.push("## Served, response not typed in OpenAPI (fields not compared)", "", ...untyped.map((m) => `- \`${m.key}\``), "");
  return L.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({
    options: {
      ref: { type: "string", multiple: true },
      openapi: { type: "string" },
      "clone-prefix": { type: "string", default: "" },
      "ref-prefix": { type: "string", default: "" },
      out: { type: "string" },
    },
  });
  if (!o.ref?.length || !o.openapi) throw new Error("give --ref <discovery dir>... --openapi <url or file>");
  const spec = /^https?:/.test(o.openapi) ? await (await fetch(o.openapi)).json() : JSON.parse(readFileSync(o.openapi, "utf8"));
  const r = diff(referenceCalls(o.ref), cloneOps(spec, o["clone-prefix"]), o["ref-prefix"]);
  const md = toMarkdown(r);
  if (o.out) writeFileSync(o.out, md);
  console.log(`reference ops ${r.refOps} · served ${r.matched.length} · not served ${r.missing.length} · field drift ${r.matched.filter((m) => m.resMissing.length || m.reqMissing.length).length}${o.out ? ` -> ${o.out}` : ""}`);
}
