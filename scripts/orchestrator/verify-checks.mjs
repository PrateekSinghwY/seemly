// The pure halves of Phase D's style, widths, websocket and overlay checks (verify.mjs runs the
// live halves). No browser, no files: each takes what was read and returns what differs.
//
//   styleDiff   the reference node's computed-style manifest (nodes/<id>/styles.json, written by
//               the walker from page-probe.mjs styleManifest) vs the clone's, matched by role,
//               name and nth like the structure check; equal, or within a declared ceiling
//   widthsDiff  structural labels (qa/labels.mjs) per width: the reference's widths.json vs the
//               clone read at the same widths
//   wsDiff      the reference node's websocket reads (nodes/<id>/ws/) vs the clone's HTTP
//               mirrors, through ws-map.json (call name -> clone method + path)
//   cropImage   an overlay's region of a screenshot, so pixels judge the overlay, not the page

import { keyPaths, template } from "../qa/api_diff.mjs";
import { diffLabels } from "../qa/labels.mjs";

// ---------- computed style ----------

/** The compared properties, in report order. Width and height are the element's box. */
export const STYLE_PROPS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "backgroundColor", "borderWidth", "borderStyle", "borderColor", "borderRadius", "padding", "margin", "width", "height", "gap", "boxShadow"];

const NUM = /-?\d+(\.\d+)?/g;

/**
 * Two computed values within `ceiling`: the same text once numbers are taken out, and every
 * number pair within the ceiling (px for lengths, channel units for colours). Ceiling 0 is equal.
 */
export function withinCeiling(a, b, ceiling = 0) {
  if (a === b) return true;
  if (!ceiling || typeof a !== "string" || typeof b !== "string") return false;
  if (a.replace(NUM, "#") !== b.replace(NUM, "#")) return false;
  const x = a.match(NUM) ?? [];
  const y = b.match(NUM) ?? [];
  return x.length === y.length && x.every((v, i) => Math.abs(+v - +y[i]) <= ceiling);
}

/**
 * styles-allow.json: `{ "ceilings": { "width": 1, "height": 1 }, "allow": [{ "element":
 * "^button \"Save\"", "prop": "width", "max": 4, "reason": "..." }] }`. A ceiling applies to a
 * property everywhere; an allow row to the elements its regex matches, and needs a reason.
 */
export function readStylesAllow(doc = {}) {
  const rows = (doc.allow ?? []).map((r) => {
    if (!r.reason) throw new Error(`styles-allow row ${r.element ?? ""} ${r.prop ?? ""} has no reason`);
    return { re: new RegExp(r.element ?? ".*"), prop: r.prop ?? null, max: r.max ?? Infinity };
  });
  return { ceilings: doc.ceilings ?? {}, rows };
}

const styleKey = (e, res) => {
  let name = e.name ?? "";
  if (name && res.some((x) => x.test(name))) name = "*";
  return `${e.role}${name ? ` "${name}"` : ""}${e.nth ? ` #${e.nth + 1}` : ""}`;
};

/**
 * Per matched element, every property that differs beyond its ceiling. Elements on one side
 * only are listed, not failed: the structure check owns presence.
 */
export function styleDiff(ref, clone, { allow = { ceilings: {}, rows: [] }, ignore = [] } = {}) {
  const res = ignore.map((p) => new RegExp(p, "i"));
  const index = (m) => new Map((m?.elements ?? []).map((e) => [styleKey(e, res), e.style ?? {}]));
  const R = index(ref);
  const C = index(clone);
  const diffs = [];
  let matched = 0;
  for (const [key, rs] of R) {
    const cs = C.get(key);
    if (!cs) continue;
    matched++;
    for (const prop of STYLE_PROPS) {
      if (!(prop in rs) && !(prop in cs)) continue;
      const row = allow.rows.find((r) => r.re.test(key) && (!r.prop || r.prop === prop));
      const ceiling = Math.max(allow.ceilings[prop] ?? 0, row ? row.max : 0);
      if (!withinCeiling(rs[prop], cs[prop], ceiling)) diffs.push({ element: key, prop, ref: rs[prop], clone: cs[prop] });
    }
  }
  return { matched, refOnly: [...R.keys()].filter((k) => !C.has(k)), cloneOnly: [...C.keys()].filter((k) => !R.has(k)), diffs, passed: !diffs.length };
}

const kebab = (p) => p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
export function styleReason(d) {
  if (d.passed) return null;
  return `${d.diffs.length} propert${d.diffs.length === 1 ? "y differs" : "ies differ"}: ${d.diffs.slice(0, 8).map((x) => `${x.element} ${kebab(x.prop)} ${x.ref} vs ${x.clone}`).join(" | ")}`;
}

// ---------- widths ----------

/** `d` less what `base` already holds: the same missing and extra labels, order, overflow. */
function beyond(d, base) {
  const out = {};
  for (const [c, x] of Object.entries(d)) {
    const b = base[c];
    if (c === "overflowX") {
      if (!b) out[c] = x;
      continue;
    }
    const less = (xs, ys = []) => {
      const left = [...ys];
      return xs.filter((v) => {
        const i = left.indexOf(v);
        if (i < 0) return true;
        left.splice(i, 1);
        return false;
      });
    };
    const missing = less(x.missing, b?.missing);
    const extra = less(x.extra, b?.extra);
    const order = x.order && !b?.order;
    if (missing.length || extra.length || order) out[c] = { missing, extra, order };
  }
  return out;
}

/**
 * `ref` is a widths.json ({ captured, widths: { "<w>": labels | null } }); `clone` maps the same
 * widths to the clone's labels (null when the scope was gone at that width). A difference the
 * capture width already has is the structure check's finding, so each width reports only what
 * differs beyond it: a layout that breaks away from the captured width. Returns one row per
 * width that does.
 */
export function widthsDiff(ref, clone, allow = new Set()) {
  const rows = [];
  let compared = 0;
  const cap = ref?.captured !== undefined ? String(ref.captured) : null;
  const base = cap && ref.widths?.[cap] && clone[cap] ? diffLabels(ref.widths[cap], clone[cap], allow) : {};
  for (const [w, labels] of Object.entries(ref?.widths ?? {})) {
    if (!labels) continue;
    compared++;
    const c = clone[w];
    if (c === undefined) continue;
    if (c === null) {
      rows.push({ width: +w, gone: true });
      continue;
    }
    const d = beyond(diffLabels(labels, c, allow), base);
    if (Object.keys(d).length) rows.push({ width: +w, diff: d });
  }
  return { compared, captured: cap === null ? null : +cap, atCapture: base, rows, passed: !rows.length };
}

export function widthsReason(d) {
  if (d.passed) return null;
  return d.rows.slice(0, 6).map((r) => {
    if (r.gone) return `@${r.width}: the overlay is gone`;
    const parts = Object.entries(r.diff).map(([c, x]) => (c === "overflowX" ? `overflow ref ${x.ref} clone ${x.clone}` : `${c}${x.missing.length ? ` missing ${x.missing.join(", ")}` : ""}${x.extra.length ? ` only on the clone ${x.extra.join(", ")}` : ""}${x.order ? " order" : ""}`));
    return `@${r.width}: ${parts.join("; ")}`;
  }).join(" | ");
}


// ---------- websocket reads vs HTTP mirrors ----------

const FRAME_META = new Set(["name", "method", "action", "type", "event", "op", "path", "route", "procedure", "channel", "topic", "id", "requestId", "reqId", "correlationId", "cid", "seq"]);

/** What a saved frame carries, read the way safety.mjs parseFrame reads it. */
export function payloadOf(frame) {
  if (frame === null || typeof frame !== "object") return null;
  if (Array.isArray(frame)) return frame[1] ?? null;
  for (const k of ["args", "params", "data", "payload", "body", "result"]) if (frame[k] !== undefined) return frame[k];
  const rest = Object.fromEntries(Object.entries(frame).filter(([k]) => !FRAME_META.has(k)));
  return Object.keys(rest).length ? rest : null;
}

const minus = (a, b) => [...a].filter((x) => !b.has(x)).sort();
const pathOf = (url) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * `refWs` are the node's saved ws reads (`{ name, sent, received }`, frames parsed); `cloneCalls`
 * the clone's HTTP calls on the node (`{ method, url, req, res }`); `map` is ws-map.json
 * (`{ "<call name>": { "method": "GET", "path": "/api/x", "request": "query" | "body" } }`).
 * A call with no map entry is "not mirrored"; a mapped call the clone never made is missing;
 * request fields (query keys for GET, else body fields) and response fields compare as for HTTP.
 */
export function wsDiff(refWs, cloneCalls, map = {}, { clonePrefix = "" } = {}) {
  const byName = new Map();
  for (const f of refWs) {
    const e = byName.get(f.name) ?? { name: f.name, req: new Set(), res: new Set(), top: new Set() };
    const sent = payloadOf(f.sent);
    const got = payloadOf(f.received);
    if (sent && typeof sent === "object") {
      keyPaths(sent, "", 0, e.req);
      if (!Array.isArray(sent)) for (const k of Object.keys(sent)) e.top.add(k);
    }
    if (got !== null && typeof got === "object") keyPaths(got, "", 0, e.res);
    byName.set(f.name, e);
  }
  const notMirrored = [];
  const missing = [];
  const drift = [];
  for (const [name, r] of byName) {
    const m = map[name];
    if (!m?.path) {
      notMirrored.push(name);
      continue;
    }
    const method = (m.method ?? "GET").toUpperCase();
    const want = template(m.path, clonePrefix);
    const label = `WS ${name} -> ${method} ${m.path}`;
    const hits = cloneCalls.filter((c) => {
      const u = pathOf(c.url);
      return u && c.method.toUpperCase() === method && template(u.pathname, clonePrefix) === want;
    });
    if (!hits.length) {
      missing.push(label);
      continue;
    }
    const mode = m.request ?? (["GET", "HEAD", "DELETE"].includes(method) ? "query" : "body");
    const req = new Set();
    const res = new Set();
    for (const c of hits) {
      if (mode === "query") for (const k of pathOf(c.url).searchParams.keys()) req.add(k);
      else if (c.req !== undefined && c.req !== null) keyPaths(c.req, "", 0, req);
      if (c.res !== undefined && c.res !== null) keyPaths(c.res, "", 0, res);
    }
    const refReq = mode === "query" ? r.top : r.req;
    const d = { key: label, reqMissing: minus(refReq, req), reqExtra: minus(req, refReq), resMissing: minus(r.res, res), resExtra: minus(res, r.res) };
    if (d.reqMissing.length || d.reqExtra.length || d.resMissing.length || d.resExtra.length) drift.push(d);
  }
  return { ops: byName.size, notMirrored, missing, drift, passed: !notMirrored.length && !missing.length && !drift.length };
}

export function wsReason(d) {
  const parts = [];
  if (d.notMirrored.length) parts.push(`ws call not mirrored: ${d.notMirrored.join(", ")}`);
  if (d.missing.length) parts.push(`mirror not called by the clone: ${d.missing.join(", ")}`);
  for (const x of d.drift) {
    const f = [];
    if (x.reqMissing.length) f.push(`request fields missing ${x.reqMissing.join(",")}`);
    if (x.reqExtra.length) f.push(`request fields only on the clone ${x.reqExtra.join(",")}`);
    if (x.resMissing.length) f.push(`response fields missing ${x.resMissing.slice(0, 12).join(",")}`);
    if (x.resExtra.length) f.push(`response fields only on the clone ${x.resExtra.slice(0, 12).join(",")}`);
    parts.push(`${x.key}: ${f.join("; ")}`);
  }
  return parts.join(" | ") || null;
}

// ---------- overlay regions ----------

/** The smallest rect holding both (either may be null). */
export function unionRect(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** A decoded image's region `rect` (CSS px, scaled by `dpr`), clipped to the image. */
export function cropImage(img, rect, dpr = 1) {
  const x0 = Math.max(0, Math.floor(rect.x * dpr));
  const y0 = Math.max(0, Math.floor(rect.y * dpr));
  const x1 = Math.min(img.width, Math.ceil((rect.x + rect.width) * dpr));
  const y1 = Math.min(img.height, Math.ceil((rect.y + rect.height) * dpr));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) img.data.copy(data, y * width * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + width) * 4);
  return { width, height, data };
}

/** Rects moved into a crop's coordinates. */
export const shiftRects = (rects, crop) => rects.map((r) => ({ ...r, x: r.x - crop.x, y: r.y - crop.y }));
