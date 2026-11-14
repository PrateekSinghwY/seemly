// Phase D per node pair (SKILL.md sections 0.4 and 6, reference/graph.md "The closed loop" step
// 3b). Every reference node `pairNodes` matched to a clone node is checked against the saved
// reference capture and the live clone node, reached by its replay route on the clone graph:
//
//   pixels     reference screenshot vs clone screenshot, same viewport and DPR, masks applied;
//              differing pixels counted per region (landmarks, plus masks.json regions)
//   structure  the saved reference AX tree (aria.yml) vs the clone's: roles, names, states, order
//   human_eye  scripts/qa/human_eye.mjs on the clone page, run as the skill runs it
//   api        the reference node's captured reads vs the clone's requests on that node: every
//              operation, its query keys, request body fields and response fields
//   writes     scripts/qa/write_roundtrip.mjs on the clone, for nodes with write edges or
//              pending writes, from the rows of a writes spec
//
// Each check writes a record in the check-record shape ({ ran, count, status, reason, at }, the
// shape scripts/lib/check-record.mjs writes) plus a detail file under
// <clone dir>/verify/<clone node>/, and the clone graph node gets
// verify: { ref, pixels, structure, human_eye, api, writes, passed, at }.
// A node is verified only when every applicable check passed with its record on disk.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import * as zlib from "node:zlib";

import { REPO, playwright, settle } from "../lib/pw.mjs";
import { keyPaths, template } from "../qa/api_diff.mjs";
import { slug } from "../qa/labels.mjs";
import { pairNodes } from "./compare.mjs";
import { UNSCOPED } from "./graph.mjs";
import { open, save } from "./store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const QA = join(here, "..", "qa");

export const CHECKS = ["pixels", "structure", "human_eye", "api", "writes"];
const NA = "not applicable";

// ---------- PNG (no dependency: the repo has no pixelmatch or pngjs) ----------

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit, non-interlaced PNG (what Chrome screenshots are) to RGBA. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let pos = 8;
  let width, height, depth, type, interlace, palette, trns;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") [width, height, depth, type, interlace] = [data.readUInt32BE(0), data.readUInt32BE(4), data[8], data[9], data[12]];
    else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[out + x - channels] : 0;
      const b = y ? px[out - stride + x] : 0;
      const c = x >= channels && y ? px[out - stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[out + x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r, g, b, al = 255;
    if (type === 0) r = g = b = px[s];
    else if (type === 4) [r, g, b, al] = [px[s], px[s], px[s], px[s + 1]];
    else if (type === 2) [r, g, b] = [px[s], px[s + 1], px[s + 2]];
    else if (type === 6) [r, g, b, al] = [px[s], px[s + 1], px[s + 2], px[s + 3]];
    else {
      const k = px[s];
      [r, g, b] = [palette[k * 3], palette[k * 3 + 1], palette[k * 3 + 2]];
      al = trns && k < trns.length ? trns[k] : 255;
    }
    rgba.set([r, g, b, al], i * 4);
  }
  return { width, height, data: rgba };
}

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = zlib.crc32 ?? ((b) => {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
});

/** Encode RGBA as a PNG (filter 0): the diff image. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- pixels ----------

// pixelmatch's perceptual colour distance (YIQ), alpha blended on white; threshold 0.1 by default.
const blend = (c, a) => 255 + (c - 255) * a;
function colorDelta(a, i, b, j) {
  const aa = a[i + 3] / 255;
  const ba = b[j + 3] / 255;
  const [r1, g1, b1] = [blend(a[i], aa), blend(a[i + 1], aa), blend(a[i + 2], aa)];
  const [r2, g2, b2] = [blend(b[j], ba), blend(b[j + 1], ba), blend(b[j + 2], ba)];
  const y = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
  const iq = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
  const q = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
  return 0.5053 * y * y + 0.299 * iq * iq + 0.1957 * q * q;
}

const inRect = (x, y, r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/**
 * Pixel diff of two decoded images. `masks` and `regions` are rects in CSS px ({ x, y, width,
 * height }, regions with a `name`), scaled by `dpr`. Masked pixels never count. A size
 * difference counts every pixel outside the shared area. Returns the count, the count per
 * region (only regions with differences), the bounding box of the differences, and a diff image.
 */
export function pixelDiff(a, b, { masks = [], regions = [], dpr = 1, threshold = 0.1 } = {}) {
  const scale = (r) => ({ ...r, x: Math.floor(r.x * dpr), y: Math.floor(r.y * dpr), width: Math.ceil(r.width * dpr), height: Math.ceil(r.height * dpr) });
  const M = masks.map(scale);
  const R = regions.map(scale);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const out = Buffer.alloc(width * height * 4, 255);
  const max = 35215 * threshold * threshold;
  const per = new Map();
  let differing = 0;
  let masked = 0;
  let box = null;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (M.some((r) => inRect(x, y, r))) {
        masked++;
        out.set([255, 230, 120, 255], o);
        continue;
      }
      const shared = x < a.width && y < a.height && x < b.width && y < b.height;
      const bad = !shared || colorDelta(a.data, (y * a.width + x) * 4, b.data, (y * b.width + x) * 4) > max;
      if (!bad) {
        const src = shared ? (y * a.width + x) * 4 : 0;
        const g = shared ? Math.round(255 - 0.1 * (255 - (a.data[src] * 0.3 + a.data[src + 1] * 0.59 + a.data[src + 2] * 0.11))) : 255;
        out.set([g, g, g, 255], o);
        continue;
      }
      differing++;
      out.set([255, 0, 0, 255], o);
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      let any = false;
      for (const r of R) if (inRect(x, y, r)) (any = true), per.set(r.name, (per.get(r.name) ?? 0) + 1);
      if (!any) per.set("(no region)", (per.get("(no region)") ?? 0) + 1);
    }
  return {
    differing,
    masked,
    total: width * height,
    sizes: { ref: [a.width, a.height], clone: [b.width, b.height] },
    regions: [...per].map(([name, n]) => ({ name, differing: n })).sort((p, q) => q.differing - p.differing),
    box: box && { x: box.x0 / dpr, y: box.y0 / dpr, width: (box.x1 - box.x0 + 1) / dpr, height: (box.y1 - box.y0 + 1) / dpr },
    image: { width, height, data: out },
  };
}

// ---------- structure (saved AX trees) ----------

/** Roles that are page structure, not data. Text, paragraphs, cells and images are data. */
export const STRUCT_ROLES = new Set([
  "heading", "button", "link", "tab", "tablist", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "columnheader", "rowheader", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton",
  "listbox", "dialog", "alertdialog", "navigation", "banner", "main", "contentinfo", "complementary", "region", "form", "search",
]);
const DATA_CONTAINERS = new Set(["row", "cell", "gridcell"]);
const STATE_ATTRS = /^(level|checked|disabled|expanded|selected|pressed)\b/;

/**
 * A Playwright ariaSnapshot (aria.yml) as an ordered list of structural entries
 * `role "name" [states]`. Digits in names are data and become `#`; names matching an `ignore`
 * pattern become `*`; anything inside a table row (but its column and row headers) is data.
 */
export function parseAria(yml, { ignore = [] } = {}) {
  const res = ignore.map((p) => new RegExp(p, "i"));
  const out = [];
  const stack = [];
  for (const raw of (yml ?? "").split("\n")) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    let body = m[2].trim();
    if (body.startsWith("'") && /'(:.*)?$/.test(body)) body = body.replace(/^'|'(?=(:.*)?$)/g, "").replace(/''/g, "'");
    if (body.startsWith("/") || body.startsWith("text:") || body.startsWith('"')) continue;
    const r = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)"| (\/.*?\/))?((?: \[[^\]]+\])*)(:.*)?$/.exec(body);
    if (!r) continue;
    const role = r[1];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const inData = stack.some((s) => DATA_CONTAINERS.has(s.role));
    stack.push({ indent, role });
    if (!STRUCT_ROLES.has(role)) continue;
    if (inData && role !== "columnheader" && role !== "rowheader") continue;
    let name = (r[2] ?? r[3] ?? "").replace(/\\"/g, '"').replace(/\s+/g, " ").trim().replace(/\d+([.,]\d+)*/g, "#");
    if (name && res.some((x) => x.test(name))) name = "*";
    const states = [...(r[4] ?? "").matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]).filter((s) => STATE_ATTRS.test(s)).sort();
    out.push(`${role}${name ? ` "${name}"` : ""}${states.map((s) => ` [${s}]`).join("")}`);
  }
  return out;
}

/** Per role: entries the reference has and the clone lacks, entries only the clone has, and order. */
export function diffAria(ref, clone) {
  const roleOf = (e) => e.split(" ")[0];
  const roles = new Set([...ref, ...clone].map(roleOf));
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const missing = [];
  const extra = [];
  for (const role of roles) {
    const a = count(ref.filter((e) => roleOf(e) === role));
    const b = count(clone.filter((e) => roleOf(e) === role));
    for (const [k, n] of a) for (let i = 0; i < n - (b.get(k) ?? 0); i++) missing.push(k);
    for (const [k, n] of b) for (let i = 0; i < n - (a.get(k) ?? 0); i++) extra.push(k);
  }
  const order = !missing.length && !extra.length && ref.join("\n") !== clone.join("\n");
  return { missing, extra, order, ref: ref.length, clone: clone.length };
}

// ---------- api ----------

const queryKeys = (url) => {
  try {
    return [...new URL(url).searchParams.keys()];
  } catch {
    return [];
  }
};
const parse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return undefined;
  }
};

/**
 * Reference reads vs clone requests on one node. Calls are `{ method, url, req, res }` (parsed
 * bodies). Grouped by `METHOD path-template` (prefixes stripped); a reference operation the clone
 * never called, a query key, request field or response field on one side only, each fails.
 * Clone operations the reference never called are listed, not failed.
 */
export function apiDiff(refCalls, cloneCalls, { refPrefix = "", clonePrefix = "", ignore = [] } = {}) {
  const res = ignore.map((p) => new RegExp(p, "i"));
  const group = (calls, prefix) => {
    const m = new Map();
    for (const c of calls) {
      let u;
      try {
        u = new URL(c.url);
      } catch {
        continue;
      }
      const key = `${c.method.toUpperCase()} ${template(u.pathname, prefix)}`;
      if (res.some((r) => r.test(key))) continue;
      const e = m.get(key) ?? { key, query: new Set(), req: new Set(), res: new Set(), calls: 0 };
      e.calls++;
      for (const k of queryKeys(c.url)) e.query.add(k);
      if (c.req !== undefined && c.req !== null) keyPaths(c.req, "", 0, e.req);
      if (c.res !== undefined && c.res !== null) keyPaths(c.res, "", 0, e.res);
      m.set(key, e);
    }
    return m;
  };
  const R = group(refCalls, refPrefix);
  const C = group(cloneCalls, clonePrefix);
  const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
  const missing = [];
  const drift = [];
  for (const [key, r] of R) {
    const c = C.get(key);
    if (!c) {
      missing.push(key);
      continue;
    }
    const d = {
      key,
      queryMissing: minus(r.query, c.query), queryExtra: minus(c.query, r.query),
      reqMissing: minus(r.req, c.req), reqExtra: minus(c.req, r.req),
      resMissing: minus(r.res, c.res), resExtra: minus(c.res, r.res),
    };
    if (Object.values(d).some((v) => Array.isArray(v) && v.length)) drift.push(d);
  }
  const extraOps = [...C.keys()].filter((k) => !R.has(k)).sort();
  return { refOps: R.size, cloneOps: C.size, missing, drift, extraOps, passed: !missing.length && !drift.length };
}

function apiReason(d) {
  const parts = [];
  if (d.missing.length) parts.push(`not called by the clone: ${d.missing.join(", ")}`);
  for (const x of d.drift) {
    const f = [];
    if (x.queryMissing.length) f.push(`query keys missing ${x.queryMissing.join(",")}`);
    if (x.queryExtra.length) f.push(`query keys only on the clone ${x.queryExtra.join(",")}`);
    if (x.reqMissing.length) f.push(`request fields missing ${x.reqMissing.join(",")}`);
    if (x.reqExtra.length) f.push(`request fields only on the clone ${x.reqExtra.join(",")}`);
    if (x.resMissing.length) f.push(`response fields missing ${x.resMissing.slice(0, 12).join(",")}`);
    if (x.resExtra.length) f.push(`response fields only on the clone ${x.resExtra.slice(0, 12).join(",")}`);
    parts.push(`${x.key}: ${f.join("; ")}`);
  }
  return parts.join(" | ") || null;
}

// ---------- records ----------

const STATUSES = new Set(["pass", "fail", "skipped"]);

/** One check record in the scripts/lib/check-record.mjs shape, in a node's verify dir, plus its detail. */
export function writeRecord(dir, name, { ran, count, status, reason = null }, detail) {
  if (!STATUSES.has(status)) throw new Error(`check record ${name}: unknown status ${status}`);
  if (status === "skipped" && ran) throw new Error(`check record ${name}: a skip cannot have run`);
  mkdirSync(dir, { recursive: true });
  const rec = { ran: Boolean(ran), count, status, reason, at: new Date().toISOString() };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rec, null, 2) + "\n");
  if (detail !== undefined) writeFileSync(join(dir, `${name}.detail.json`), JSON.stringify(detail, null, 1) + "\n");
  return rec;
}

const notApplicable = (why) => ({ ran: false, count: 0, status: "skipped", reason: `${NA}: ${why}` });

/** Is a node verified, judged from the graph node and the records on disk (never the graph alone)? */
export function nodeVerified(cloneDir, node, refId) {
  const v = node?.verify;
  if (!v?.passed || (refId && v.ref !== refId)) return false;
  for (const c of CHECKS) {
    const p = join(cloneDir, "verify", node.id, `${c}.json`);
    if (!existsSync(p)) return false;
    const rec = JSON.parse(readFileSync(p, "utf8"));
    if (v[c]?.status === "n/a") {
      if (rec.status !== "skipped" || !String(rec.reason ?? "").startsWith(NA)) return false;
    } else if (rec.status !== "pass") return false;
  }
  return true;
}

// ---------- pairs, scoped ----------

export function readPairs(cloneDir) {
  const p = join(cloneDir, "pairs.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function writePairs(cloneDir, doc) {
  mkdirSync(cloneDir, { recursive: true });
  writeFileSync(join(cloneDir, "pairs.json"), JSON.stringify(doc, null, 1));
}

/** The pairs document narrowed to one scope (the reference node's tag; clone-only by the clone's tag, else by view key). */
export function scopePairs(doc, scope) {
  if (!scope) return doc;
  const hit = (s) => (scope === UNSCOPED ? !s : s === scope);
  const pairs = doc.pairs.filter((p) => hit(p.scope));
  const refOnly = doc.refOnly.filter((p) => hit(p.scope));
  const keys = new Set([...pairs, ...refOnly].map((p) => p.key));
  const tagged = doc.cloneOnly.some((c) => c.clone.scope);
  const cloneOnly = doc.cloneOnly.filter((c) => (tagged ? hit(c.clone.scope) : keys.has(c.key)));
  return { ...doc, scope, pairs, refOnly, cloneOnly };
}

/** verified N / built M / ref-only K (G with a gap or bounded reason), from pairs.json, the clone graph and the records. */
export function verifyCounts(cloneDir, scope) {
  const doc = readPairs(cloneDir);
  if (!doc) return null;
  const graph = JSON.parse(readFileSync(join(cloneDir, "graph.json"), "utf8"));
  const s = scopePairs(doc, scope);
  const verified = s.pairs.filter((p) => nodeVerified(cloneDir, graph.nodes[p.clone.id], p.ref.id)).length;
  const reasoned = s.refOnly.filter((p) => p.status === "gap" || p.status === "bounded").length;
  return { verified, built: s.pairs.length, refOnly: s.refOnly.length, refOnlyReasoned: reasoned, refOnlyUnbuilt: s.refOnly.length - reasoned, cloneOnly: s.cloneOnly.length, at: doc.at };
}

export const countsLine = (c) =>
  `verified ${c.verified} / built ${c.built} / ref-only ${c.refOnly} (${c.refOnlyReasoned} gap or bounded, ${c.refOnlyUnbuilt} not built)${c.cloneOnly ? ` · clone-only ${c.cloneOnly}` : ""}`;

// ---------- report ----------

const cell = (v) => (!v ? "not run" : v.status === "n/a" ? "n/a" : v.status === "pass" ? "pass" : v.status === "fail" ? "**FAIL**" : v.status);
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown: ref node -> clone node -> each check -> reason, then every ref-only node with its reason. */
export function report(cloneDir, scope) {
  const doc = readPairs(cloneDir);
  if (!doc) throw new Error(`no pairs.json in ${cloneDir}: run compare or verify first`);
  const graph = JSON.parse(readFileSync(join(cloneDir, "graph.json"), "utf8"));
  const s = scopePairs(doc, scope);
  const c = verifyCounts(cloneDir, scope);
  const L = [`# Phase D report${scope ? `: ${scope}` : ""}`, "", `${countsLine(c)}. Pairs from ${doc.at}.`, ""];
  L.push("## Built: reference node -> clone node", "", "| reference node | clone node | pixels | structure | human eye | api | writes | verified | reason |", "|---|---|---|---|---|---|---|---|---|");
  for (const p of s.pairs) {
    const n = graph.nodes[p.clone.id];
    const v = n?.verify?.ref === p.ref.id ? n.verify : null;
    const ok = nodeVerified(cloneDir, n, p.ref.id);
    const why = v ? CHECKS.filter((k) => v[k] && !["pass", "n/a"].includes(v[k].status)).map((k) => `${k}: ${v[k].reason ?? v[k].status}`).join("; ") : "Phase D not run";
    L.push(`| ${esc(p.ref.label)} \`${p.ref.id}\` | ${esc(p.clone.label)} \`${p.clone.id}\` | ${CHECKS.map((k) => cell(v?.[k])).join(" | ")} | ${ok ? "yes" : "no"} | ${esc(why)} |`);
  }
  L.push("", "## Reference only: what the clone does not have", "", "| reference node | kind | view | status | reason |", "|---|---|---|---|---|");
  for (const p of s.refOnly) L.push(`| ${esc(p.ref.label)} \`${p.ref.id}\` | ${p.kind} | \`${esc(p.key)}\` | ${p.status} | ${esc(p.reason)} |`);
  if (s.cloneOnly.length) {
    L.push("", "## Clone only: surfaces the reference walk never reached", "", "| clone node | kind | view |", "|---|---|---|");
    for (const p of s.cloneOnly) L.push(`| ${esc(p.clone.label)} \`${p.clone.id}\` | ${p.kind} | \`${esc(p.key)}\` |`);
  }
  return L.join("\n") + "\n";
}

// ---------- the clone, live ----------

async function locate(p, el) {
  if (el.css) {
    const l = p.locator(`css=${el.css}`);
    if ((await l.count()) === 1 && (await l.isVisible().catch(() => false))) return l;
  }
  if (el.role && el.role !== "generic" && el.name) {
    const l = p.getByRole(el.role, { name: el.name, exact: true });
    if ((await l.count()) > (el.nth ?? 0)) return l.nth(el.nth ?? 0);
  }
  if (el.name) {
    const l = p.getByText(el.name, { exact: true });
    if (await l.count()) return l.first();
  }
  return null;
}

/**
 * Put `page` on clone node `n` by its cheapest replay route on the clone graph; returns the
 * overlay scope, if any. The in-page helpers come from page-probe.mjs, loaded here so the pure
 * checks above never depend on the walker's files.
 */
export async function reachClone(page, g, n, { dismiss } = {}) {
  const { FLOATING_SEL, clearMarks, markFloating, newOverlays, openOnLoad } = await import("./page-probe.mjs");
  const path = g.route(n.id);
  if (path === null) throw new Error("unreachable on the clone graph without a write");
  let from = path.length ? path[0].from : n.id;
  let rest = path;
  for (let i = path.length - 1; i >= 0; i--) {
    if (g.node(path[i].to).kind === "page") {
      from = path[i].to;
      rest = path.slice(i + 1);
      break;
    }
  }
  const start = g.node(from);
  const resp = await page.goto(start.href ?? start.url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await settle(page);
  if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()} on ${start.href ?? start.url}`);
  if (n.state?.startsWith("on-load:")) {
    const ovs = await page.evaluate(openOnLoad);
    return { scopeCss: (ovs.find((o) => `on-load:${o.name}` === n.state) ?? ovs[0])?.css ?? null };
  }
  if (dismiss) await dismiss(page).catch(() => {});
  let scopeCss = null;
  for (let i = 0; i < rest.length; i++) {
    const e = rest[i];
    const last = i === rest.length - 1;
    const overlay = last && n.kind !== "page" && n.kind !== "state";
    if (overlay) await page.evaluate(markFloating, FLOATING_SEL);
    if (e.kind !== "redirect") {
      const l = await locate(page, e.element);
      if (!l) throw new Error(`replay: "${e.element.name || e.element.css}" not found`);
      if (e.kind === "hover") await l.hover({ timeout: 4000 });
      else await l.click({ timeout: 4000 });
      await settle(page, 2500);
    }
    if (overlay) scopeCss = (await page.evaluate(newOverlays, FLOATING_SEL))[0]?.css ?? null;
  }
  await page.evaluate(clearMarks).catch(() => {});
  return { scopeCss };
}

/** Rects (CSS px, page coordinates when `full`) of every visible match of `selector`. */
async function rectsOf(page, selector, full) {
  return page.evaluate(({ selector, full }) => {
    const out = [];
    let els = [];
    try {
      els = [...document.querySelectorAll(selector)];
    } catch {
      return out;
    }
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ x: r.left + (full ? scrollX : 0), y: r.top + (full ? scrollY : 0), width: r.width, height: r.height });
    }
    return out;
  }, { selector, full });
}

/** Landmark regions of the clone page, named by role and label, for "differing pixels per region". */
async function landmarks(page, full) {
  return page.evaluate((full) => {
    const SEL = "header,nav,main,aside,footer,[role=banner],[role=navigation],[role=main],[role=complementary],[role=contentinfo],[role=dialog],[role=alertdialog],[role=menu],[role=region][aria-label],section[aria-label],form[aria-label]";
    const role = (el) => el.getAttribute("role") || { HEADER: "banner", NAV: "navigation", MAIN: "main", ASIDE: "complementary", FOOTER: "contentinfo", SECTION: "region", FORM: "form" }[el.tagName] || el.tagName.toLowerCase();
    const seen = new Map();
    const out = [];
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const label = (el.getAttribute("aria-label") || el.querySelector("h1,h2,h3")?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 40);
      let name = `${role(el)}${label ? ` "${label}"` : ""}`;
      const k = (seen.get(name) ?? 0) + 1;
      seen.set(name, k);
      if (k > 1) name += ` #${k}`;
      out.push({ name, x: r.left + (full ? scrollX : 0), y: r.top + (full ? scrollY : 0), width: r.width, height: r.height });
    }
    return out;
  }, full);
}

/** Entries of masks.json that apply to a pair (no `node`, `"*"`, or the ref or clone node id). */
const forPair = (rows = [], pair) => rows.filter((m) => !m.node || [m.node].flat().some((x) => x === "*" || x === pair.ref.id || x === pair.clone.id));

/** Run one QA script as the skill runs it, in its own folder; returns its exit code, output and check record. */
function runQa(script, args, cwd, recordName) {
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    execFile(process.execPath, [join(QA, script), ...args], { cwd, env: { ...process.env, RL_REPO: REPO, SEEMLY_DISCOVERY: join(cwd, "d") }, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const p = join(cwd, "never_to_be_pushed", "discovery", "checks", `${recordName}.json`);
      resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}`, record: existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null });
    });
  });
}

/** human_eye.mjs over every clone page in one browser; findings per URL from its own output files. */
async function humanEye(urls, runDir, { width, allowFile }) {
  if (!urls.length) return new Map();
  const args = [...urls.flatMap((u) => ["--url", u]), "--width", String(width)];
  if (allowFile) args.push("--allow", allowFile);
  const r = await runQa("human_eye.mjs", args, runDir, "human_eye_qa");
  const out = new Map();
  for (const u of urls) {
    const f = join(runDir, "d", "qa", "human-eye", `${slug(u)}.json`);
    out.set(u, existsSync(f) ? { findings: JSON.parse(readFileSync(f, "utf8")), record: r.record } : { error: r.out.trim().split("\n").slice(-3).join(" ") || `exit ${r.code}` });
  }
  return out;
}

const writeRowsFor = (rows, pair) => rows.filter((w) => {
  if (w.node) return [w.node].flat().some((x) => x === pair.ref.id || x === pair.clone.id);
  if (w.at) {
    const path = (u) => {
      try {
        return new URL(u).pathname;
      } catch {
        return u;
      }
    };
    return [w.at].flat().some((p) => path(pair.ref.url) === p || path(pair.clone.url) === p || new RegExp(`^${p}$`).test(path(pair.clone.url)));
  }
  return false;
});

/** Write edges and pending writes the reference walk recorded on a node. */
function refWrites(pair, refEdges, pendingByDir) {
  const edges = Object.values(refEdges.get(pair.ref.dir) ?? {}).filter((e) => e.from === pair.ref.id && e.kind === "write").map((e) => e.element?.name ?? e.id);
  const pend = (pendingByDir.get(pair.ref.dir) ?? []).filter((p) => p.node === pair.ref.id).map((p) => p.element?.name ?? p.key);
  return [...new Set([...edges, ...pend])];
}

function loadJsonl(p) {
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/**
 * Phase D over the pairs of a reference walk and a clone walk. Options: `scope`, `node` (a ref or
 * clone node id), `masks` (masks.json), `writes` (write_roundtrip rows, each with `node` or `at`),
 * `refPrefix`/`clonePrefix` (API path prefixes), `dpr`, `height` (viewport), `api`/`web` (clone
 * bases for the round trip). Returns the per-pair results; saves records, pairs.json and the graph.
 */
export async function verify({ refDirs, cloneDir, scope, node, masks: masksFile, writes: writesFile, refPrefix = "", clonePrefix = "", dpr = 1, height = 900, api, web, log = (s) => console.error(s) } = {}) {
  refDirs = [refDirs].flat();
  const doc = pairNodes(refDirs, [cloneDir]);
  writePairs(cloneDir, doc);
  let pairs = scopePairs(doc, scope).pairs;
  if (node) pairs = pairs.filter((p) => p.ref.id === node || p.clone.id === node);
  const cfg = masksFile ? JSON.parse(readFileSync(masksFile, "utf8")) : {};
  const writeRows = writesFile ? JSON.parse(readFileSync(writesFile, "utf8")) : [];
  const g = open(cloneDir);
  const origin = g.data.meta.origin ?? (() => {
    const any = Object.values(g.data.nodes).find((n) => n.entry);
    return any ? new URL(any.href ?? any.url).origin : undefined;
  })();
  const refEdges = new Map(refDirs.map((d) => [d, JSON.parse(readFileSync(join(d, "graph.json"), "utf8")).edges]));
  const pendingByDir = new Map(refDirs.map((d) => [d, loadJsonl(join(d, "pending-writes.jsonl"))]));
  let dismiss = null;
  try {
    ({ dismissOnLoad: dismiss } = await import("./explore.mjs"));
  } catch {}

  const runs = join(cloneDir, "verify", "_runs");
  const refShot = (p) => {
    const n = JSON.parse(readFileSync(join(p.ref.dir, "graph.json"), "utf8")).nodes[p.ref.id];
    return { n, art: n.info?.artifacts ? join(p.ref.dir, n.info.artifacts) : null };
  };
  const widthOf = (art) => {
    try {
      return Math.round(decodePng(readFileSync(join(art, "screenshot.png"))).width / dpr);
    } catch {
      return 1440;
    }
  };

  let allowFile = null;
  if (cfg.humanEye?.allow?.length) {
    allowFile = join(runs, "human-eye-allow.json");
    mkdirSync(runs, { recursive: true });
    writeFileSync(allowFile, JSON.stringify(cfg.humanEye.allow));
  }
  const firstArt = pairs.length ? refShot(pairs[0]).art : null;
  const eye = await humanEye([...new Set(pairs.map((p) => g.node(p.clone.id).href ?? p.clone.url))], join(runs, "human_eye"), { width: firstArt ? widthOf(firstArt) : 1440, allowFile });

  const { chromium } = pairs.length ? await playwright() : {};
  const browser = pairs.length ? await chromium.launch() : null;
  const results = [];
  try {
    for (const pair of pairs) {
      const cn = g.node(pair.clone.id);
      const { n: rn, art } = refShot(pair);
      const out = join(cloneDir, "verify", cn.id);
      mkdirSync(out, { recursive: true });
      const v = { ref: pair.ref.id, at: new Date().toISOString() };
      const put = (name, rec, detail, extra = {}) => {
        writeRecord(out, name, rec, detail);
        v[name] = { status: rec.reason?.startsWith(NA) ? "n/a" : rec.status, reason: rec.reason, ...extra };
      };
      const shotPath = art && join(art, "screenshot.png");
      const width = art && existsSync(shotPath) ? widthOf(art) : 1440;
      const full = rn.kind === "page";
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const bodies = [];
      page.on("response", (res) => {
        const req = res.request();
        if (!["xhr", "fetch"].includes(req.resourceType()) || !/json/.test(res.headers()["content-type"] ?? "")) return;
        bodies.push(Promise.race([res.text().then((body) => ({ method: req.method(), url: res.url(), req: parse(req.postData()), res: parse(body) })).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]));
      });
      let scopeCss = null;
      let reachError = null;
      try {
        ({ scopeCss } = await reachClone(page, g, cn, { dismiss }));
      } catch (e) {
        reachError = e.message.split("\n")[0];
      }

      if (reachError) {
        for (const c of CHECKS.filter((c) => c !== "human_eye")) put(c, { ran: false, count: 0, status: "skipped", reason: `clone node not reached: ${reachError}` });
      } else {
        // pixels
        if (!shotPath || !existsSync(shotPath)) put("pixels", { ran: false, count: 0, status: "skipped", reason: "no reference screenshot: re-capture the node" });
        else {
          await page.mouse.move(0, 0).catch(() => {});
          const buf = await page.screenshot({ fullPage: full, timeout: 20000 });
          writeFileSync(join(out, "clone.png"), buf);
          copyFileSync(shotPath, join(out, "ref.png"));
          const masks = [];
          for (const m of forPair(cfg.masks, pair)) {
            if (m.selector) masks.push(...(await rectsOf(page, m.selector, full)));
            else masks.push({ x: m.x, y: m.y, width: m.width, height: m.height });
          }
          const regions = await landmarks(page, full);
          for (const r of forPair(cfg.regions, pair)) {
            if (r.selector) regions.push(...(await rectsOf(page, r.selector, full)).map((x) => ({ ...x, name: r.name ?? r.selector })));
            else regions.push({ name: r.name, x: r.x, y: r.y, width: r.width, height: r.height });
          }
          const d = pixelDiff(decodePng(readFileSync(shotPath)), decodePng(buf), { masks, regions, dpr, threshold: cfg.threshold ?? 0.1 });
          writeFileSync(join(out, "diff.png"), encodePng(d.image));
          const max = cfg.maxDiffPixels ?? 0;
          const { image, ...detail } = d;
          put("pixels", {
            ran: true, count: d.differing, status: d.differing > max ? "fail" : "pass",
            reason: d.differing > max ? `${d.differing} differing pixel(s)${d.sizes.ref.join("x") !== d.sizes.clone.join("x") ? ` (size ref ${d.sizes.ref.join("x")}, clone ${d.sizes.clone.join("x")})` : ""}; by region: ${d.regions.slice(0, 6).map((r) => `${r.name} ${r.differing}`).join(", ")}` : null,
          }, { ...detail, masks, regions, viewport: { width, height, dpr }, fullPage: full }, { differing: d.differing, regions: d.regions.slice(0, 10) });
        }

        // structure and accessibility tree
        const ariaPath = art && join(art, "aria.yml");
        if (!ariaPath || !existsSync(ariaPath) || !readFileSync(ariaPath, "utf8").trim()) put("structure", { ran: false, count: 0, status: "skipped", reason: "no reference AX tree: re-capture the node" });
        else {
          const cloneAria = await page.locator(scopeCss ? `css=${scopeCss}` : "body").ariaSnapshot({ timeout: 20000 }).catch(() => "");
          writeFileSync(join(out, "clone.aria.yml"), cloneAria);
          const ignore = cfg.structure?.ignore ?? [];
          const d = diffAria(parseAria(readFileSync(ariaPath, "utf8"), { ignore }), parseAria(cloneAria, { ignore }));
          const bad = d.missing.length || d.extra.length || d.order;
          put("structure", {
            ran: true, count: d.ref, status: bad ? "fail" : "pass",
            reason: bad ? [d.missing.length && `missing on the clone: ${d.missing.slice(0, 8).join(" | ")}`, d.extra.length && `only on the clone: ${d.extra.slice(0, 8).join(" | ")}`, d.order && "same entries, different order"].filter(Boolean).join("; ") : null,
          }, d);
        }

        // api: the reference node's captured reads vs the clone's requests on this node
        const invPath = art && join(art, "inventory.json");
        const inv = invPath && existsSync(invPath) ? JSON.parse(readFileSync(invPath, "utf8")) : null;
        const refCalls = (inv?.requests ?? []).map((r) => ({
          method: r.method, url: r.url,
          res: r.file && existsSync(join(art, "xhr", r.file)) ? parse(readFileSync(join(art, "xhr", r.file), "utf8")) : undefined,
          req: r.reqFile && existsSync(join(art, "xhr", r.reqFile)) ? parse(readFileSync(join(art, "xhr", r.reqFile), "utf8")) : undefined,
        }));
        const cloneCalls = (await Promise.all(bodies)).filter(Boolean);
        if (!inv) put("api", { ran: false, count: 0, status: "skipped", reason: "no reference inventory: re-capture the node" });
        else if (!refCalls.length) put("api", notApplicable("the reference node made no captured reads"), { cloneCalls: cloneCalls.map((c) => `${c.method} ${c.url}`) });
        else {
          const d = apiDiff(refCalls, cloneCalls, { refPrefix, clonePrefix, ignore: cfg.api?.ignore ?? [] });
          put("api", { ran: true, count: d.refOps, status: d.passed ? "pass" : "fail", reason: d.passed ? null : apiReason(d) }, { ...d, refCalls: refCalls.map((c) => `${c.method} ${c.url}`), cloneCalls: cloneCalls.map((c) => `${c.method} ${c.url}`) });
        }
      }

      // human eye on the clone page
      const he = eye.get(cn.href ?? pair.clone.url);
      if (!he || he.error) put("human_eye", { ran: false, count: 0, status: "skipped", reason: `human_eye.mjs did not run: ${he?.error ?? "no result"}` });
      else put("human_eye", { ran: true, count: he.findings.length, status: he.findings.length ? "fail" : "pass", reason: he.findings.length ? `${he.findings.length} finding(s): ${he.findings.slice(0, 5).map((f) => `${f.kind} ${f.detail}`).join(" | ")}` : null }, { findings: he.findings, overlay: cn.kind !== "page" ? "run on the page under the overlay" : undefined });

      // writes, on the clone only
      if (!reachError) {
        const needed = refWrites(pair, refEdges, pendingByDir);
        const rows = writeRowsFor(writeRows, pair);
        if (!needed.length && !rows.length) put("writes", notApplicable("no write edges or pending writes on the reference node"));
        else if (!rows.length) put("writes", { ran: false, count: needed.length, status: "skipped", reason: `write(s) with no round-trip spec: ${needed.join(", ")}` }, { needed });
        else {
          const spec = join(runs, `writes-${cn.id}.json`);
          mkdirSync(runs, { recursive: true });
          writeFileSync(spec, JSON.stringify(rows.map(({ node: _n, at: _a, ...r }) => r), null, 1));
          const r = await runQa("write_roundtrip.mjs", ["--spec", spec, "--api", api ?? origin, "--web", web ?? origin], join(runs, `writes-${cn.id}`), "write_round_trip");
          const fails = r.out.split("\n").filter((l) => /^ {4}\S/.test(l)).map((l) => l.trim());
          if (!r.record) put("writes", { ran: false, count: rows.length, status: "skipped", reason: `write_roundtrip.mjs did not run: ${r.out.trim().split("\n").slice(-2).join(" ")}` });
          else put("writes", { ran: true, count: rows.length, status: r.record.status, reason: r.record.status === "pass" ? null : fails.join(" | ") || r.record.reason }, { needed, rows: rows.map((x) => x.name), output: r.out });
        }
      }
      await context.close().catch(() => {});

      v.passed = CHECKS.every((c) => v[c] && (v[c].status === "pass" || v[c].status === "n/a")) && CHECKS.some((c) => v[c]?.status === "pass");
      cn.verify = v;
      if (v.passed && cn.status !== "verified") g.setStatus(cn.id, "verified");
      else if (!v.passed && cn.status === "verified") g.setStatus(cn.id, "closed");
      save(g, cloneDir);
      results.push({ pair, verify: v });
      log(`${v.passed ? "✓" : "✗"} ${pair.ref.label.slice(0, 50)} -> ${cn.id}  ${CHECKS.map((c) => `${c} ${v[c]?.status ?? "-"}`).join(" · ")}`);
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  return { results, pairs: doc };
}
