// Reference graph vs clone graph: the click-by-click gap list. Pages are matched by their
// path family plus the query keys that select a view (`open_calendar`, `tab`), never by data;
// then, per page, every control the reference walked is looked up in the clone's walk by its
// label (digits normalised, as the clone's data differs from the reference's).
//
// Five findings per page:
//   missing     a control the reference shows that the clone does not render
//   disabled    live on the reference, disabled on the clone
//   dead        on the reference it opened or changed something; on the clone the same control did nothing
//   no-surface  a dialog, menu or state the reference opens from this page that the clone never shows
//   interactions  a right-click, double-click, key, drag, input, submit or upload that opens or
//               changes something on the reference and nothing on the clone (`edgeDiff` judges
//               the same per node pair, edge by edge, for verify's `interactions` check)
// plus whole pages the reference has and the clone has none of.
//
// `pairPages` pairs views first: a reference view key with the clone view a pair map names (the
// clone keeps its own URL scheme), else the same key, else a flagged fuzzy match.
// `pairNodes` goes one level finer, node by node, for Phase D (`verify.mjs`): every reference
// node is paired with at most one clone node of the paired view and the same kind, the best by
// structure (skeleton similarity), control labels and state title. What is left over is
// ref-only (with its gap or bounded reason when it has one) or clone-only. Written as pairs.json.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { similarity } from "./algorithms.mjs";
import { pathPattern } from "./bound.mjs";
import { UNSCOPED, gapReason, inScopeId, routeHash } from "./graph.mjs";
import { VERB, rowKey } from "./interactions.mjs";

const OPENED = new Set(["navigation", "overlay", "hover-overlay", "state", "popup", "page", "known", "bounded"]);

export const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/\d+([.,]\d+)*/g, "#").trim();

/**
 * Which view of a route a URL is: path family plus the flag-like query keys (values only for
 * short enums), plus the route fragment's family in a hash-routed app (`/metaui#/list/:id`).
 */
export function viewKey(url) {
  const u = new URL(url);
  const keys = [...u.searchParams.keys()].filter((k) => /^(open_|tab$|view$|section$)/.test(k)).sort();
  const route = routeHash(url).split("?")[0];
  return `${pathPattern(u.pathname)}${keys.length ? `?${keys.join("&")}` : ""}${route ? `#${pathPattern(route.slice(1))}` : ""}`;
}

const RANK = { verified: 5, built: 4, closed: 3, expanding: 1, frontier: 1, bounded: 0, gap: 0 };

/** Every node of one side's walk (one graph dir or several workers' copies), the most advanced copy kept, with the dir it lives in. */
export function loadNodes(dirs) {
  const best = new Map();
  for (const dir of [dirs].flat()) {
    const g = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
    for (const n of Object.values(g.nodes)) {
      const prev = best.get(n.id);
      if (!prev || RANK[n.status] > RANK[prev.n.status]) best.set(n.id, { n, dir, edges: g.edges });
    }
  }
  return best;
}

/** A side's nodes in `scope`. A side that carries no scope tags at all is not filtered (its scope is unknown, not empty). */
function scoped(best, scope) {
  if (!scope) return best;
  const tagged = [...best.values()].some(({ n }) => n.scope);
  if (!tagged && scope !== UNSCOPED) return best;
  return new Map([...best].filter(([, { n }]) => inScopeId(n, scope)));
}

/** One side's walk, from one graph dir or several (parallel workers over one site): nodes unioned, the most advanced copy kept. */
function load(dirs, scope) {
  const best = scoped(loadNodes(dirs), scope);
  const pages = new Map();
  for (const { n, dir } of best.values()) {
    if (n.status === "gap" || n.status === "bounded") continue;
    const key = viewKey(n.href ?? n.url);
    const p = pages.get(key) ?? { key, nodes: [], controls: new Map(), surfaces: new Map(), interactions: new Map() };
    pages.set(key, p);
    p.nodes.push(n);
    const inv = n.info?.artifacts && join(dir, n.info.artifacts, "inventory.json");
    if (inv && existsSync(inv)) {
      const doc = JSON.parse(readFileSync(inv, "utf8"));
      for (const r of doc.interactions ?? []) {
        if (r.unfired !== undefined || !r.name) continue;
        const k = rowKey(r);
        const prev = p.interactions.get(k);
        p.interactions.set(k, { ...r, opened: (prev?.opened ?? false) || (r.to?.length ?? 0) > 0 });
      }
      for (const c of doc.candidates) {
        if (!c.name) continue;
        const k = `${c.role}|${norm(c.name)}`;
        const prev = p.controls.get(k);
        const opened = OPENED.has(c.outcome) || (c.children?.length ?? 0) > 0;
        p.controls.set(k, { role: c.role, name: c.name, disabled: (prev?.disabled ?? true) && c.outcome === "disabled", opened: (prev?.opened ?? false) || opened, inert: (prev?.inert ?? true) && (c.outcome === "inert" || c.outcome === "disabled"), node: n.id });
      }
    }
    if (n.kind !== "page") p.surfaces.set(`${n.kind}|${norm(n.state.replace(/^[a-z-]+:/, ""))}`, n);
  }
  return { pages };
}

/** Labels match when equal after normalising, or when one contains the other (the clone often names a control more fully). */
function findControl(clone, role, name) {
  const n = norm(name);
  for (const c of clone.controls.values()) if (norm(c.name) === n) return c;
  for (const c of clone.controls.values()) {
    const m = norm(c.name);
    if (n.length >= 4 && (m.includes(n) || n.includes(m) && m.length >= 4)) return c;
  }
  return null;
}

/**
 * The shell: controls and surfaces seen on at least `minViews` views of one side. The walker
 * expands shell controls on two templates only, so judging the shell page by page reports it
 * missing everywhere else; it is compared once, as the union over all views.
 */
function shellOf(side, minViews = 3) {
  const seen = new Map();
  const surfaces = new Map();
  for (const p of side.pages.values()) {
    for (const [k, c] of p.controls) (seen.get(k) ?? seen.set(k, { c, views: new Set() }).get(k)).views.add(p.key);
    for (const [k, n] of p.surfaces) (surfaces.get(k) ?? surfaces.set(k, { n, views: new Set() }).get(k)).views.add(p.key);
  }
  const controls = new Map([...seen].filter(([, v]) => v.views.size >= minViews).map(([k, v]) => [k, v.c]));
  const surf = new Map([...surfaces].filter(([, v]) => v.views.size >= minViews).map(([k, v]) => [k, v.n]));
  return { key: "(shell: header, menus, banner)", controls, surfaces: surf };
}

function union(side) {
  const controls = new Map();
  const surfaces = new Map();
  const interactions = new Map();
  for (const p of side.pages.values()) for (const [k, r] of p.interactions ?? []) interactions.set(k, { ...r, opened: (interactions.get(k)?.opened ?? false) || r.opened });
  for (const p of side.pages.values()) {
    for (const [k, c] of p.controls) {
      const prev = controls.get(k);
      controls.set(k, prev ? { ...prev, disabled: prev.disabled && c.disabled, opened: prev.opened || c.opened, inert: prev.inert && c.inert } : c);
    }
    for (const [k, n] of p.surfaces) surfaces.set(k, n);
  }
  return { controls, surfaces, interactions };
}

function diffPage(rp, cp, skip = new Set(), skipSurf = new Set()) {
  const row = { key: rp.key, missing: [], disabled: [], dead: [], noSurface: [], interactions: [] };
  // Interactions besides the click: one the reference answers that the clone does not.
  for (const [k, r] of rp.interactions ?? []) {
    if (!r.opened) continue;
    const c = cp.interactions?.get(k);
    if (!c?.opened) row.interactions.push(`${VERB[r.kind] ?? r.kind}${r.key && r.role !== "shortcut" ? ` ${r.key}` : ""} on "${r.name}"${r.case ? ` [${r.case}]` : ""}`);
  }
  for (const [k, c] of rp.controls) {
    if (skip.has(k)) continue;
    const m = findControl(cp, c.role, c.name);
    if (!m) row.missing.push(c.name);
    else if (!c.disabled && m.disabled) row.disabled.push(c.name);
    else if (c.opened && !m.opened && m.inert) row.dead.push(c.name);
  }
  const cloneTitles = [...cp.surfaces.keys()];
  for (const [k, n] of rp.surfaces) {
    if (skipSurf.has(k)) continue;
    const [kind, title] = k.split("|");
    if (!title) continue;
    if (!cloneTitles.some((t) => t.split("|")[1] === title || (title.length >= 4 && t.split("|")[1].includes(title)))) row.noSurface.push(`${kind}: ${n.state.replace(/^[a-z-]+:/, "")}`);
  }
  return row;
}

/**
 * The page-level diff. With `pairMap` (readPairMap), a reference view is diffed against the clone
 * view the map names, else the clone view of the same key, else (map given) the most similar
 * unclaimed clone view, flagged as a fuzzy pair; `pairing` lists each reference view's source.
 */
export function compare(refDirs, cloneDirs, { scope, pairMap = null } = {}) {
  const ref = load(refDirs, scope);
  const clone = load(cloneDirs, scope);
  const pagePairs = pairPages(scoped(loadNodes(refDirs), scope), scoped(loadNodes(cloneDirs), scope), pairMap);
  const shell = shellOf(ref);
  const out = { pagesMissing: [], pages: [diffPage(shell, union(clone))], pairing: [...pagePairs.values()] };
  for (const [key, rp] of ref.pages) {
    const pp = pagePairs.get(key);
    const cp = pp?.clone ? clone.pages.get(pp.clone) : null;
    if (!cp) {
      out.pagesMissing.push({ key, example: rp.nodes[0].url, kinds: [...new Set(rp.nodes.map((n) => n.kind))], source: pp?.source ?? "none", mapped: pp?.clone ?? null });
      continue;
    }
    const row = diffPage(rp, cp, new Set(shell.controls.keys()), new Set(shell.surfaces.keys()));
    row.clone = pp.clone;
    row.source = pp.source;
    out.pages.push(row);
  }
  return out;
}

export function toMarkdown(r) {
  const L = ["# Reference vs clone: walked-graph diff", ""];
  if (r.pagesMissing.length) {
    L.push("## Views the reference has and the clone has none of", "", "| view | example | kinds | pairing |", "|---|---|---|---|");
    for (const p of r.pagesMissing) L.push(`| \`${p.key}\` | ${p.example} | ${p.kinds.join(", ")} | ${p.mapped ? `${p.source} -> \`${p.mapped}\`, which the clone walk never reached` : p.source ?? "none"} |`);
    L.push("");
  }
  const fuzzy = (r.pairing ?? []).filter((p) => p.source === "fuzzy");
  if (fuzzy.length) {
    L.push("## Fuzzy pairs: confirm each, then add it to the pair map", "", "| reference view | clone view | score |", "|---|---|---|");
    for (const p of fuzzy) L.push(`| \`${p.ref}\` | \`${p.clone}\` | ${p.score} |`);
    L.push("");
  }
  for (const p of r.pages) {
    const n = p.missing.length + p.disabled.length + p.dead.length + p.noSurface.length + (p.interactions?.length ?? 0);
    if (!n) continue;
    L.push(`## \`${p.key}\`${p.clone && p.clone !== p.key ? ` -> \`${p.clone}\` (${p.source})` : ""} (${n})`, "");
    if (p.noSurface.length) L.push(`- **opens on the reference, never on the clone:** ${p.noSurface.join(" · ")}`);
    if (p.dead.length) L.push(`- **does something on the reference, nothing on the clone:** ${p.dead.join(" · ")}`);
    if (p.interactions?.length) L.push(`- **an interaction answers on the reference, not on the clone:** ${p.interactions.join(" · ")}`);
    if (p.disabled.length) L.push(`- **disabled on the clone only:** ${p.disabled.join(" · ")}`);
    if (p.missing.length) L.push(`- **not rendered on the clone:** ${p.missing.join(" · ")}`);
    L.push("");
  }
  return L.join("\n");
}

// ---------- node pairs (Phase D) ----------

/** Normalised control labels a node's walk saved (inventory.json), for the label overlap score. */
function controlLabels(n, dir) {
  const inv = n.info?.artifacts && join(dir, n.info.artifacts, "inventory.json");
  if (!inv || !existsSync(inv)) return new Set();
  try {
    return new Set(JSON.parse(readFileSync(inv, "utf8")).candidates.filter((c) => c.name).map((c) => `${c.role}|${norm(c.name)}`));
  } catch {
    return new Set();
  }
}

const jaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
};

/** The title part of a state (`modal:Edit listing` -> `edit listing`), normalised. */
const stateTitle = (n) => norm((n.state ?? "").replace(/^[a-z-]+:/, ""));
const titlesMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));

/** Why a reference node has no clone twin when the walk itself says so (gap or bounded). */
function refReason(n) {
  if (n.status === "gap") return `gap: ${gapReason(n) ?? "no reason recorded"}`;
  if (n.status === "bounded") return `bounded: ${n.bound ?? n.detail ?? "no reason recorded"}`;
  return null;
}

// ---------- page pairs: reference view key -> clone view key ----------
//
// A clone rarely keeps the reference's URL scheme (`/metaui#/list/KioskConfiguration` on the
// reference, `/administration/kiosk-configurations` on the clone), so pairing by identical view
// key alone pairs nothing. A pair map names the clone view of each reference view:
//
//   { "about": "...", "fuzzy": 0.6,
//     "map": { "/metaui#/list/KioskConfiguration": "/administration/kiosk-configurations",
//              "/ia#/dataView/:id": "/reports/library/:id",
//              "/metaui#/list/:entity": "/admin/:entity",
//              "re:^/wfc/applications/(\\w+)/": "/legacy/$1" },
//     "rules": [{ "ref": "/timekeeping#/(?<tab>\\w+)$", "on": "url", "clone": "/time/$<tab>" }] }
//
// A `map` key is a reference view key (matched exactly), a view key with `:name` segments (each
// matches one segment and fills `:name` in the clone side), or `re:<regex>`. A `rules` entry's
// `ref` is a regex tested against `on`: the view key, the full URL or the route (path plus hash);
// all three when `on` is omitted. `$1` / `$<name>` fill the clone side. The clone side is a view
// key, a route or a URL, normalised to a view key. Exact keys win; then patterns in file order.
// A bare object (no `map`, no `rules`) is read as the map itself.
//
// An unmapped reference view pairs with the clone view of the same key; else, when a map is in
// force and `fuzzy` is not false, with the most similar clone view nothing else claimed: page
// structure (skeleton similarity, 0.5) plus control labels (Jaccard, 0.5) at least `fuzzy`
// (default FUZZY_MIN). A fuzzy pair is reported for a person to confirm.

export const FUZZY_MIN = 0.6;
const BASE = "http://pair-map.invalid";
const META_KEYS = new Set(["about", "fuzzy", "rules", "map"]);

/** A route, view key or URL as written in a pair map, normalised to a view key. */
export function keyFromRoute(s) {
  const v = String(s ?? "").trim();
  try {
    return viewKey(/^https?:\/\//.test(v) ? v : `${BASE}${v.startsWith("/") ? v : `/${v}`}`);
  } catch {
    return v;
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `/metaui#/list/:entity` -> /^\/metaui#\/list\/(?<entity>[^/#?]+)$/ (a repeated name is matched, not captured again). */
function paramPattern(key) {
  const seen = new Set();
  const src = key.split(/(:[A-Za-z_]\w*)/).map((part) => {
    const m = /^:([A-Za-z_]\w*)$/.exec(part);
    if (!m) return escapeRe(part);
    if (seen.has(m[1])) return "[^/#?]+";
    seen.add(m[1]);
    return `(?<${m[1]}>[^/#?]+)`;
  }).join("");
  return new RegExp(`^${src}$`);
}

function compileRule(ref, clone, on = null) {
  if (typeof ref !== "string" || typeof clone !== "string") throw new Error(`pair map entry ${JSON.stringify(ref)} -> ${JSON.stringify(clone)}: both sides must be strings`);
  if (on && !["key", "url", "route"].includes(on)) throw new Error(`pair map rule ${ref}: "on" is key, url or route`);
  if (on || ref.startsWith("re:")) return { kind: "regex", ref, re: new RegExp(on ? ref : ref.slice(3)), on, clone };
  const key = keyFromRoute(ref);
  return { kind: /:[A-Za-z_]\w*/.test(key) ? "params" : "key", ref, key, re: /:[A-Za-z_]\w*/.test(key) ? paramPattern(key) : null, clone };
}

/** A pair-map file (or object) compiled: `{ rules, fuzzy, file }`; null when none is given. */
export function readPairMap(src) {
  if (!src) return null;
  const doc = typeof src === "string" ? JSON.parse(readFileSync(src, "utf8")) : src;
  const entries = doc.map ?? Object.fromEntries(Object.entries(doc).filter(([k]) => !META_KEYS.has(k)));
  const rules = [];
  for (const [ref, clone] of Object.entries(entries)) rules.push(compileRule(ref, clone));
  for (const r of doc.rules ?? []) rules.push(compileRule(r.ref, r.clone, r.on ?? null));
  const fuzzy = doc.fuzzy === false ? false : typeof doc.fuzzy === "number" ? doc.fuzzy : FUZZY_MIN;
  return { rules, fuzzy, file: typeof src === "string" ? src : null };
}

function fill(target, m) {
  const groups = m.groups ?? {};
  return target
    .replace(/\$<(\w+)>/g, (_, k) => groups[k] ?? "")
    .replace(/\$(\d+)/g, (_, i) => m[+i] ?? "")
    .replace(/:([A-Za-z_]\w*)/g, (all, k) => (k in groups ? groups[k] : all));
}

/** The clone view key the map gives a reference node (by its view key, URL and route), with the rule that gave it; or null. */
export function mapView(pairMap, n) {
  if (!pairMap) return null;
  const url = n.href ?? n.url;
  let key;
  let route = "";
  try {
    key = viewKey(url);
    const u = new URL(url);
    route = `${u.pathname}${u.hash}`;
  } catch {
    key = url;
  }
  for (const r of pairMap.rules) if (r.kind === "key" && r.key === key) return { clone: keyFromRoute(r.clone), rule: r.ref };
  for (const r of pairMap.rules) {
    if (r.kind === "key") continue;
    const subjects = r.kind === "params" ? [key] : r.on ? [{ key, url, route }[r.on]] : [key, url, route];
    for (const s of subjects) {
      const m = r.re.exec(s);
      if (m) return { clone: keyFromRoute(fill(r.clone, m)), rule: r.ref };
    }
  }
  return null;
}

const nodeKey = (n) => {
  try {
    return viewKey(n.href ?? n.url);
  } catch {
    return n.url;
  }
};
const liveNode = (n) => n.status !== "gap" && n.status !== "bounded";

/**
 * Every reference view key -> `{ ref, clone, source, score?, rule?, scope, example }`, where
 * source is `map`, `key`, `fuzzy` or `none`. `ref` and `clone` are loadNodes maps.
 */
export function pairPages(ref, clone, pairMap = null, { labelsOf = ({ n, dir }) => controlLabels(n, dir) } = {}) {
  const byKey = (side) => {
    const m = new Map();
    for (const x of side.values()) {
      if (!liveNode(x.n)) continue;
      const k = nodeKey(x.n);
      (m.get(k) ?? m.set(k, []).get(k)).push(x);
    }
    return m;
  };
  const refKeys = byKey(ref);
  const cloneKeys = byKey(clone);
  const out = new Map();
  const claimed = new Set();
  const open = [];
  for (const [key, xs] of refKeys) {
    const lead = xs.find((x) => x.n.kind === "page") ?? xs[0];
    const base = { ref: key, scope: lead.n.scope ?? null, example: lead.n.href ?? lead.n.url };
    const hit = mapView(pairMap, lead.n);
    if (hit) {
      out.set(key, { ...base, clone: hit.clone, source: "map", rule: hit.rule, reached: cloneKeys.has(hit.clone) });
      claimed.add(hit.clone);
    } else if (cloneKeys.has(key)) {
      out.set(key, { ...base, clone: key, source: "key" });
      claimed.add(key);
    } else {
      out.set(key, { ...base, clone: null, source: "none" });
      open.push(key);
    }
  }
  const min = pairMap ? pairMap.fuzzy : false;
  if (min === false || !open.length) return out;
  const pagesOf = (xs) => xs.filter((x) => x.n.kind === "page");
  const cands = [];
  for (const rk of open) {
    const rps = pagesOf(refKeys.get(rk));
    for (const [ck, cxs] of cloneKeys) {
      if (claimed.has(ck)) continue;
      let best = 0;
      for (const r of rps) for (const c of pagesOf(cxs)) best = Math.max(best, 0.5 * similarity(r.n.signature ?? [], c.n.signature ?? []) + 0.5 * jaccard(labelsOf(r), labelsOf(c)));
      if (best >= min) cands.push({ rk, ck, score: best });
    }
  }
  cands.sort((a, b) => b.score - a.score || (a.rk < b.rk ? -1 : a.rk > b.rk ? 1 : a.ck < b.ck ? -1 : 1));
  const usedR = new Set();
  for (const x of cands) {
    if (usedR.has(x.rk) || claimed.has(x.ck)) continue;
    usedR.add(x.rk);
    claimed.add(x.ck);
    out.set(x.rk, { ...out.get(x.rk), clone: x.ck, source: "fuzzy", score: Math.round(x.score * 1000) / 1000 });
  }
  return out;
}

/**
 * Pair every reference node with at most one clone node: same paired view (pairPages: the
 * pair map's clone view, else the same view key, else a fuzzy pair) and same kind, then the best score of structure (skeleton similarity, 0.5), control
 * labels (Jaccard, 0.3) and state title (0.2). An overlay or state pairs only when its title
 * matches or its structure is at least half the same. Greedy by score, one to one.
 * Gap and bounded nodes on either side never pair: a reference one is ref-only with its reason.
 */
export function pairNodes(refDirs, cloneDirs, { scope, pairMap = null } = {}) {
  const refAll = loadNodes(refDirs);
  const ref = scoped(refAll, scope);
  const cloneAll = loadNodes(cloneDirs);
  const live = liveNode;
  const keyOf = nodeKey;
  const cloneBy = new Map();
  for (const c of cloneAll.values()) {
    if (!live(c.n)) continue;
    const k = `${keyOf(c.n)}|${c.n.kind}`;
    (cloneBy.get(k) ?? cloneBy.set(k, []).get(k)).push(c);
  }
  const labels = new Map();
  const labelsOf = ({ n, dir }) => labels.get(`${dir}|${n.id}`) ?? labels.set(`${dir}|${n.id}`, controlLabels(n, dir)).get(`${dir}|${n.id}`);
  const pages = pairPages(ref, cloneAll, pairMap, { labelsOf });
  const target = (n) => pages.get(keyOf(n))?.clone ?? null;

  const candidates = [];
  const refOnly = [];
  for (const r of ref.values()) {
    const reason = refReason(r.n);
    if (reason) {
      refOnly.push({ r, reason });
      continue;
    }
    const pool = cloneBy.get(`${target(r.n)}|${r.n.kind}`) ?? [];
    for (const c of pool) {
      const structure = similarity(r.n.signature ?? [], c.n.signature ?? []);
      const title = titlesMatch(stateTitle(r.n), stateTitle(c.n)) ? 1 : 0;
      if (r.n.kind !== "page" && !title && structure < 0.5) continue;
      const lab = jaccard(labelsOf(r), labelsOf(c));
      candidates.push({ r, c, structure, labels: lab, title, score: 0.5 * structure + 0.3 * lab + 0.2 * title });
    }
  }
  candidates.sort((a, b) => b.score - a.score || (a.r.n.id < b.r.n.id ? -1 : a.r.n.id > b.r.n.id ? 1 : a.c.n.id < b.c.n.id ? -1 : 1));
  const usedR = new Set();
  const usedC = new Set();
  const pairs = [];
  for (const x of candidates) {
    if (usedR.has(x.r.n.id) || usedC.has(x.c.n.id)) continue;
    usedR.add(x.r.n.id);
    usedC.add(x.c.n.id);
    pairs.push(x);
  }
  for (const r of ref.values()) if (!refReason(r.n) && !usedR.has(r.n.id)) refOnly.push({ r, reason: null });

  const refKeys = new Set([...ref.values()].flatMap((r) => [keyOf(r.n), target(r.n)]).filter(Boolean));
  const cloneTagged = [...cloneAll.values()].some(({ n }) => n.scope);
  const cloneOnly = [...cloneAll.values()].filter(({ n }) => live(n) && !usedC.has(n.id) && (!scope || (cloneTagged ? inScopeId(n, scope) : refKeys.has(keyOf(n)))));

  const side = ({ n, dir }) => ({ id: n.id, label: n.label, url: n.href ?? n.url, kind: n.kind, dir, scope: n.scope ?? null });
  const round = (v) => Math.round(v * 1000) / 1000;
  const via = (n) => pages.get(keyOf(n)) ?? { clone: null, source: "none" };
  return {
    at: new Date().toISOString(),
    scope: scope ?? null,
    ref: [refDirs].flat(),
    clone: [cloneDirs].flat(),
    pairMap: pairMap ? (pairMap.file ?? "(inline)") : null,
    pages: [...pages.values()].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0)),
    pairs: pairs.map((x) => ({ key: keyOf(x.r.n), cloneKey: keyOf(x.c.n), source: via(x.r.n).source, kind: x.r.n.kind, scope: x.r.n.scope ?? null, ref: side(x.r), clone: side(x.c), score: { total: round(x.score), structure: round(x.structure), labels: round(x.labels), title: x.title } })),
    refOnly: refOnly.map(({ r, reason }) => ({ key: keyOf(r.n), cloneKey: via(r.n).clone, source: via(r.n).source, kind: r.n.kind, scope: r.n.scope ?? null, ref: side(r), status: r.n.status, reason: reason ?? "not on the clone" })),
    cloneOnly: cloneOnly.map((c) => ({ key: keyOf(c.n), kind: c.n.kind, clone: side(c) })),
  };
}

// ---------- edges, node pair by node pair (verify's `interactions` check) ----------

/** One side's interaction rows on one node: clicks from `candidates`, every other kind from `interactions`. */
export function interactionRows(inv) {
  const rows = [];
  for (const c of inv?.candidates ?? []) rows.push({ kind: "click", role: c.role, name: c.name, outcome: c.outcome, unfired: c.unfired, to: c.children ?? [], blocked: c.blocked });
  for (const r of inv?.interactions ?? []) rows.push(r);
  return rows;
}

/** A row that sent a write: the writes check owns it (the reference's outcome is the failure path). */
const isWriteRow = (r) => r.outcome === "write-attempt" || (r.blocked?.length ?? 0) > 0;
/** Unfired on the clone where the reference fired: these are defects, the rest are not compared. */
const CLONE_DEFECT = new Set(["disabled", "not-found", "unclickable", "not-focusable", "submit-disabled", "no-submit"]);
const OUTCOME_CLASS = (o) => (/^native-dialog: /.test(o ?? "") ? "a native dialog" : /^download: /.test(o ?? "") ? "a download" : o);

/**
 * Edge-level comparison of one node pair. For every reference row (kind, key or case, element
 * role and name), the clone row of the same key must lead to a node that pairs with the
 * reference target (`pairOf`: ref id -> clone id), or both must change nothing, or both end in
 * the same fired result. A gap or bounded target on both sides matches by URL family. Rows the
 * reference did not fire, and write rows, are not compared; a documented shortcut declared not
 * implemented (keyboards.json) is listed as declared, not failed. Upload rows also compare the
 * accept list and size limit. Returns `{ compared, failures, notCompared, declared, passed }`;
 * each failure carries a message ("right-click on 'X' opens nothing on the clone").
 */
export function edgeDiff(refInv, cloneInv, { pairOf = new Map(), refNodes = {}, cloneNodes = {} } = {}) {
  const ref = interactionRows(refInv);
  const clone = interactionRows(cloneInv);
  const byKey = new Map();
  for (const r of clone) (byKey.get(rowKey(r)) ?? byKey.set(rowKey(r), []).get(rowKey(r))).push(r);
  const names = new Set(clone.map((r) => `${r.role}|${norm(r.name)}`));
  const pairedClone = new Set(pairOf.values());
  const label = (nodes, id) => (nodes[id] ? `"${String(nodes[id].label ?? id).slice(0, 60)}"` : id);
  const family = (n) => {
    try {
      return n.status === "gap" ? new URL(n.href ?? n.url).toString().split("#")[0] : viewKey(n.href ?? n.url);
    } catch {
      return n.url;
    }
  };
  const sameTarget = (a, b) =>
    a.some((t) => {
      const p = pairOf.get(t);
      if (p) return b.includes(p);
      const rn = refNodes[t];
      return b.some((c) => {
        const cn = cloneNodes[c];
        return rn && cn && !pairedClone.has(c) && ["gap", "bounded"].includes(rn.status) && ["gap", "bounded"].includes(cn.status) && family(rn) === family(cn);
      });
    });
  const failures = [];
  const notCompared = [];
  const declared = [];
  let compared = 0;
  for (const r of ref) {
    if (r.unfired !== undefined || isWriteRow(r)) {
      // An upload never fired on the reference (no writes there) still compares its accept list and size limit.
      if (!(r.kind === "upload" && (r.unfired === "upload-needs-writes" || r.unfired === undefined))) {
        notCompared.push({ row: rowKey(r), why: r.unfired ?? "write on the reference (the writes check owns it)" });
        continue;
      }
    }
    const q = byKey.get(rowKey(r));
    const c = q?.shift();
    const verb = `${VERB[r.kind] ?? r.kind}${r.kind === "key" ? ` ${r.key}` : ""}`;
    const what = r.role === "shortcut" ? `${verb}` : `${verb} on '${r.name}'${r.case ? ` [${r.case}]` : ""}`;
    const fail = (message) => {
      if (r.kind === "key" && r.declared?.implemented === false) declared.push({ row: rowKey(r), message, reason: r.declared.reason ?? null });
      else failures.push({ kind: r.kind, key: rowKey(r), element: { role: r.role, name: r.name }, message });
    };
    compared++;
    if (r.kind === "upload") {
      if (!c) fail(`${what}: no such file input on the clone`);
      else if ((r.accept ?? []).join(",") !== (c.accept ?? []).join(",")) fail(`${what} accepts ${(r.accept ?? []).join(", ") || "anything"} on the reference, ${(c.accept ?? []).join(", ") || "anything"} on the clone`);
      else if ((r.maxSize ?? null) !== (c.maxSize ?? null)) fail(`${what} is limited to ${r.maxSize ?? "no size"} on the reference, ${c.maxSize ?? "no size"} on the clone`);
      continue;
    }
    // No row on the clone: the control is there but takes no such interaction (no listener, no
    // binding), so it changes nothing; or the control is not there at all.
    const cr = c ?? (r.role === "shortcut" || names.has(`${r.role}|${norm(r.name)}`) ? { outcome: "inert", to: [] } : null);
    if (!cr) {
      fail(`${what}: no such control on the clone`);
      continue;
    }
    if (cr.unfired !== undefined) {
      if (CLONE_DEFECT.has(cr.unfired)) fail(`${what}: ${cr.unfired} on the clone`);
      else {
        compared--;
        notCompared.push({ row: rowKey(r), why: `clone ${cr.unfired}` });
      }
      continue;
    }
    if (isWriteRow(cr)) {
      compared--;
      notCompared.push({ row: rowKey(r), why: "write on the clone (the writes check owns it)" });
      continue;
    }
    const a = r.to ?? [];
    const b = cr.to ?? [];
    if (!a.length && !b.length) {
      if (OUTCOME_CLASS(r.outcome) !== OUTCOME_CLASS(cr.outcome)) fail(`${what}: ${OUTCOME_CLASS(r.outcome)} on the reference, ${OUTCOME_CLASS(cr.outcome)} on the clone`);
    } else if (a.length && !b.length) fail(`${what} opens nothing on the clone (the reference opens ${label(refNodes, a[0])})`);
    else if (!a.length) fail(`${what} does nothing on the reference, opens ${label(cloneNodes, b[0])} on the clone`);
    else if (!sameTarget(a, b)) fail(`${what} opens ${label(refNodes, a[0])} on the reference, ${label(cloneNodes, b[0])} on the clone (not a pair)`);
  }
  return { compared, failures, notCompared, declared, passed: !failures.length };
}

export function interactionsReason(d) {
  if (d.passed) return null;
  return `${d.failures.length} interaction(s) differ: ${d.failures.slice(0, 8).map((f) => f.message).join(" | ")}`;
}
