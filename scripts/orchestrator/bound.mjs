// Scope and STATE_BOUND (SKILL.md section 4): what the explorer may follow, and when a family
// of URLs has been sampled enough. Pure functions over a plain object kept in graph meta, so a
// resumed run keeps its counts.

import { routeHash } from "./graph.mjs";

/** Linked values kept per family before the rest are recorded as out of range. */
export const STATE_BOUND = 30;

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{12,}$/i,
  /^\d{4}-\d{2}(-\d{2})?$/,
  /^(?=.*\d)[A-Za-z0-9_-]{16,}$/,
  /^(?=[^-]*[a-z])(?=.*\d)[a-z0-9]+(-[a-z0-9]+)*-\d+$/i,
];

/** `/listing/123/edit` and `/listing/456/edit` are one family: `/listing/:id/edit`. */
export function pathPattern(pathname) {
  return pathname
    .split("/")
    .map((s) => (s && ID_SEGMENT.some((re) => re.test(decodeURIComponent(s))) ? ":id" : s))
    .join("/");
}

/** Same origin and under one of the build's path prefixes (one, or a list for a multi-area scope). */
export function inScope(raw, { origin, prefix = "/" }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return false;
  return (Array.isArray(prefix) ? prefix : [prefix]).some((pre) => {
    const p = pre.endsWith("/") ? pre : `${pre}/`;
    return pre === "/" || u.pathname === pre || u.pathname.startsWith(p);
  });
}

/**
 * Admit one discovered URL against the bounds. A URL already admitted is always admitted
 * again (dedupe happens in the graph). Returns `{ ok: true }` or `{ ok: false, bound }` where
 * `bound` says which family hit its limit, for the node's `bound` field.
 */
export function admit(bounds, raw, limit = STATE_BOUND, { anyHash = false } = {}) {
  bounds.paths ??= {};
  bounds.query ??= {};
  const u = new URL(raw);
  // A hash-routed app's screens live in the fragment: `/app#/item/7` is family `/app#/item/:id`.
  const route = routeHash(raw, { anyHash }).split("?")[0];
  const pattern = `${u.origin}${pathPattern(u.pathname)}${route ? `#${pathPattern(route.slice(1))}` : ""}`;
  const concrete = `${u.origin}${u.pathname}${route}`;
  const fam = (bounds.paths[pattern] ??= { kept: [], over: 0 });
  if (!fam.kept.includes(concrete)) {
    if (pattern !== concrete && fam.kept.length >= limit) {
      fam.over++;
      return { ok: false, bound: `path family ${pattern}: ${limit} kept, ${fam.over} more out of range` };
    }
    fam.kept.push(concrete);
  }
  for (const [k, v] of new URL(raw).searchParams) {
    const key = `${concrete}?${k}`;
    const q = (bounds.query[key] ??= { kept: [], over: 0 });
    if (q.kept.includes(v)) continue;
    if (q.kept.length >= limit) {
      q.over++;
      return { ok: false, bound: `query ${key}: ${limit} values kept, ${q.over} more out of range` };
    }
    q.kept.push(v);
  }
  return { ok: true };
}

/**
 * Repeated siblings (table rows, cards in a grid) share a css path up to their nth-of-type
 * indexes. The explorer samples a group instead of clicking all 999 rows: the first few, and
 * more only while they keep leading somewhere new.
 */
export function repeatGroup(css) {
  return css.replace(/:nth-of-type\(\d+\)/g, "");
}

// ---------- data rows ----------

/** Distinct members a css group needs before its elements count as data rows (a grid, a list). */
export const ROW_MIN = 3;

/** Samples fired per (row template, interaction kind) before more need a new lead each time. */
export const ROW_SAMPLE = 2;

// Data-like tokens, most specific first. Names are "Last, First" (an optional middle initial);
// a pair followed by ", and" / ", or" is a list of words ("Show, Hide, and Filter"), not a person.
const DATA_TOKENS = [
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>"],
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>"],
  [/\b\d{1,2}(?::\d{2}){1,2}\s*(?:[AaPp]\.?[Mm]\.?)?(?![\w:])|\b\d{1,2}\s*[AaPp]\.?[Mm]\.?(?!\w)/g, "<time>"],
  [/\b\d{1,4}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g, "<date>"],
  [/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?\b/g, "<date>"],
  [/\b(?:Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(?:day|sday|nesday|rsday|urday)?\b\.?/g, "<day>"],
  [/\b[A-Z][\p{L}'’-]+(?: [A-Z][\p{L}'’-]+)?, [A-Z][\p{L}'’-]+(?: [A-Z]\.?)?(?![\p{L}'’-])(?!,? (?:and|or)\b)/gu, "<name>"],
  [/\d+(?:[.,]\d+)*/g, "#"],
];

/**
 * A title or label with its data replaced by placeholders: person names ("Last, First"), dates,
 * weekdays, times and time ranges, numbers. "Abbott, Olivia, Sun 11/08, 6:30 PM-3:00 AM" and
 * every other shift chip read "<name>, <day> <date>, <time>-<time>"; "Approve timecard" and
 * "Sign-off" stay what they are. page-probe.mjs `contentKeyOf` runs the same rules in the page
 * (it cannot import): change both together; content-key.test.mjs holds them equal.
 */
export function normaliseData(s) {
  let out = String(s ?? "");
  for (const [re, to] of DATA_TOKENS) out = out.replace(re, to);
  return out;
}

// A class or id an app minted at runtime: a token with a run of 6+ digits (`.grid1794721638366`) or
// of 8+ hex characters mixing digits and letters (`#menu-a3f9c2e1b7`). It differs per page load.
const GENERATED = /(?<![\w$-])[.#]?[A-Za-z_$-]*(?:\d{6,}|(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,})[\w$-]*/gi;

/**
 * A label or state key with generated class names and ids taken out: "overlay: .grid1794721638366 .
 * · Hide column" is "overlay: Hide column", the same on every load. Separators a removed token
 * leaves alone are dropped too.
 */
export function stripGenerated(s) {
  const out = String(s ?? "")
    .replace(GENERATED, "")
    .replace(/(^|\s)[.#:]+(?=\s|$)/g, "$1")
    .split("·")
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" · ");
  return out.replace(/: · /g, ": ").trim();
}

/** The repeat groups in `list` (by `css`) with at least ROW_MIN distinct members: data rows. */
export function rowGroups(list, cssOf = (c) => c.css) {
  const by = new Map();
  for (const c of list) {
    const css = cssOf(c);
    if (!css) continue;
    const g = repeatGroup(css);
    (by.get(g) ?? by.set(g, new Set()).get(g)).add(css);
  }
  return new Set([...by].filter(([, s]) => s.size >= ROW_MIN).map(([g]) => g));
}

/** A short stable id for a row template (a css group), for state keys. */
export function rowId(group) {
  let h = 0x811c9dc5;
  for (let i = 0; i < group.length; i++) h = Math.imul(h ^ group.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------- repeated click triggers ----------

/** Roles whose repeated siblings each do their own thing (a tab per view, an item per command): never sampled. */
const UNSAMPLED_ROLES = new Set(["tab", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "radio", "checkbox", "switch", "treeitem", "combobox", "link", "textbox", "slider"]);

// Hint tokens that say what kind of column or row a trigger sits on: kept even when every member
// carries one (a page of number columns only) or one member does (a single number column).
const TYPE_TOKEN = /(?:^|[-_:=])(?:num|numeric|number|integer|decimal|currency|money|amount|percent|date|datetime|bool|boolean|right)(?:$|[-_])/i;

/**
 * Repeated click triggers on one node (a ▾ per column header, a kebab per row): ROW_MIN or more
 * non-link candidates of one role and css template whose names follow one pattern (shared words,
 * or one name for all). Each member gets its group (role and css
 * template), a sub-group `hint` (the class and data-type tokens of the trigger and its cell that
 * set some members apart: a number column against a text column; tokens on one member only, a
 * column's own id, are its data and are dropped), and `text`: the part of its name the members do
 * not share ("Employee id" of "Employee id column, more actions"). Returns Map css -> that.
 */
export function clickGroups(candidates) {
  const by = new Map();
  for (const c of candidates) {
    if (c.href || !c.css || UNSAMPLED_ROLES.has(c.role) || c.field || c.options) continue;
    const g = `${c.role}|${repeatGroup(c.css)}`;
    (by.get(g) ?? by.set(g, []).get(g)).push(c);
  }
  const out = new Map();
  for (const [group, list] of by) {
    if (new Set(list.map((c) => c.css)).size < ROW_MIN) continue;
    const freq = new Map();
    for (const c of list) for (const t of new Set(c.hint ?? [])) freq.set(t, (freq.get(t) ?? 0) + 1);
    const names = list.map((c) => String(c.name ?? ""));
    let pre = names[0];
    let suf = names[0];
    for (const nm of names) {
      while (!nm.startsWith(pre)) pre = pre.slice(0, -1);
      while (!nm.endsWith(suf)) suf = suf.slice(1);
    }
    // whole words only: "Employee id" and "Employee name" share "Employee ", not "Employee n"
    pre = pre.slice(0, pre.search(/[^\s,:;·|/-]*$/));
    suf = suf.slice(suf.search(/(?:^|[\s,:;·|/-])/) === -1 ? suf.length : suf.search(/[\s,:;·|/-]/));
    // A trigger pattern: the members' names share words ("<column> column, more actions") or are
    // all one name (a kebab per row). A toolbar of different commands (Approve, Sign-off, Team A)
    // is not one: each fires and keeps its own name.
    if (!/\p{L}/u.test(pre + suf) && new Set(names).size > 1) continue;
    for (const c of list) {
      const hint = [...new Set(c.hint ?? [])].filter((t) => TYPE_TOKEN.test(t) || (freq.get(t) >= 2 && freq.get(t) < list.length)).sort().join(" ");
      const nm = String(c.name ?? "");
      const text = nm.length > pre.length + suf.length ? nm.slice(pre.length, nm.length - suf.length).trim() : "";
      out.set(c.css, { group, hint, text, id: rowId(`${group}|${hint}`) });
    }
  }
  return out;
}

/** `s` with a trigger's own text (`clickGroups` `text`: a column's name) as <item>, whole words only. */
export function maskItem(s, text) {
  const str = String(s ?? "");
  if (!text || text.length < 2) return str;
  const re = new RegExp(`(?<![\\p{L}\\d])${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "gu");
  return str.replace(re, "<item>");
}

/**
 * Sampling of interactions on data rows, per (page, row template, kind), across every node of the
 * walk: K samples, then one more only while every sample so far led somewhere new (a new
 * template), never more than STATE_BOUND. `store` is a plain object kept in graph meta
 * (`rowSamples`), so a resumed or chunked walk keeps its counts.
 */
export function rowSampler(store = {}, { k = ROW_SAMPLE, limit = STATE_BOUND } = {}) {
  const at = (key) => (store[key] ??= { tried: 0, leads: [] });
  return {
    /** May one more member of this group fire? Counts it when yes. */
    take(key) {
      const s = at(key);
      if (s.exempt) return true;
      const ok = s.tried < k || (s.tried < limit && s.leads.length === s.tried);
      if (ok) s.tried++;
      return ok;
    },
    /** A sample that never fired (not found, not restored): it does not count. */
    release(key) {
      const s = at(key);
      if (s.tried > 0) s.tried--;
    },
    /** This group's members do not all open one kind of thing (a tab strip): every member fires. */
    exempt(key) {
      at(key).exempt = true;
    },
    /** What the sample led to (a template id, or an outcome when nothing opened). */
    lead(key, lead) {
      const s = at(key);
      if (!s.leads.includes(lead)) s.leads.push(lead);
    },
    store,
  };
}

/**
 * `O dedupe`: merge the states an older walk minted per data row (one per person, date or shift)
 * into one node per (page, kind, row template, interaction kind, normalised label, template). A
 * node qualifies when every edge into it comes from a member of one row group of one interaction
 * kind. The keeper is a closed node with artifacts when there is one (a closed sample is kept);
 * the others' edges are rewritten to it (self-loops dropped, duplicates merged) and they are
 * removed. The group's row sampler is seeded as sampled, so a later walk does not re-explode it.
 * `dryRun` changes nothing. Returns `{ groups, collapsed, kept, removed }`.
 */
export function dedupeRows(data, { dryRun = false, edgeId, k = ROW_SAMPLE } = {}) {
  const N = data.nodes;
  const E = data.edges;
  const KEYED = new Set(["overlay", "modal", "menu", "state"]);
  const into = new Map();
  const members = new Map();
  for (const e of Object.values(E)) {
    (into.get(e.to) ?? into.set(e.to, []).get(e.to)).push(e);
    const css = e.element?.css;
    if (!css || !N[e.from]) continue;
    const key = `${N[e.from].url}|${e.kind}|${repeatGroup(css)}`;
    (members.get(key) ?? members.set(key, new Set()).get(key)).add(css);
  }
  const groups = new Map();
  for (const n of Object.values(N)) {
    if (!KEYED.has(n.kind) || n.entry) continue;
    const es = into.get(n.id) ?? [];
    if (!es.length) continue;
    const keys = new Set();
    let row = true;
    for (const e of es) {
      const css = e.element?.css;
      const from = N[e.from];
      if (!css || !from || e.kind === "navigation" || (members.get(`${from.url}|${e.kind}|${repeatGroup(css)}`)?.size ?? 0) < ROW_MIN) {
        row = false;
        break;
      }
      keys.add(`${from.url}|${e.kind}|${repeatGroup(css)}`);
    }
    if (!row || keys.size !== 1) continue;
    const [sample] = keys;
    const gk = `${n.url}|${n.kind}|${sample}|${normaliseData(n.label)}|${n.template}`;
    (groups.get(gk) ?? groups.set(gk, { sample, nodes: [] }).get(gk)).nodes.push(n);
  }
  const out = { groups: 0, collapsed: 0, kept: [], removed: [] };
  const mapTo = new Map();
  for (const { sample, nodes } of groups.values()) {
    if (nodes.length < 2) continue;
    nodes.sort(keeperFirst);
    const [keep, ...rest] = nodes;
    out.groups++;
    out.collapsed += rest.length;
    out.kept.push({ id: keep.id, label: normaliseData(keep.label), merged: rest.length });
    for (const r of rest) {
      mapTo.set(r.id, keep.id);
      out.removed.push(r.id);
    }
    if (dryRun) continue;
    const [url, kind, group] = sample.split("|");
    data.meta.rowSamples ??= {};
    data.meta.rowSamples[`${url}|${kind}|${group}`] = { tried: Math.max(k, data.meta.rowSamples[`${url}|${kind}|${group}`]?.tried ?? 0), leads: [keep.template] };
    keep.depth = Math.min(...nodes.map((n) => n.depth ?? Infinity));
    keep.label = normaliseData(keep.label);
    keep.info = { ...(keep.info ?? {}), rowGroup: group, merged: rest.map((r) => r.id) };
  }
  if (!dryRun) rewire(data, mapTo, edgeId);
  return out;
}

/** The node a collapsed group keeps: a closed one with artifacts first, then the shallowest. */
function keeperFirst(a, b) {
  const rank = (n) => [["closed", "built", "verified"].includes(n.status) ? 0 : n.status === "frontier" ? 1 : 2, n.info?.artifacts ? 0 : 1, n.depth ?? Infinity, n.id];
  const x = rank(a);
  const y = rank(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Point every edge at the kept nodes (`mapTo`: removed id -> kept id), drop the removed nodes, recount templates. */
function rewire(data, mapTo, edgeId) {
  if (!mapTo.size) return;
  const N = data.nodes;
  const E = data.edges;
  const edges = {};
  for (const e of Object.values(E)) {
    const from = mapTo.get(e.from) ?? e.from;
    const to = mapTo.get(e.to) ?? e.to;
    if (from === to && (mapTo.has(e.from) || mapTo.has(e.to))) continue;
    const id = from === e.from && to === e.to ? e.id : edgeId({ from, to, kind: e.kind, element: e.element });
    if (edges[id]) continue;
    edges[id] = { ...e, id, from, to };
  }
  data.edges = edges;
  for (const id of mapTo.keys()) delete N[id];
  for (const t of Object.values(data.templates)) {
    t.members = t.members.filter((id) => N[id]);
    t.inDegree = 0;
  }
  for (const e of Object.values(edges)) {
    const t = data.templates[N[e.to]?.template];
    if (t) t.inDegree++;
  }
}

/** Edge kinds a click trigger reaches its overlay by: the click, its Enter key, its hover, or a click that sent a write. */
const CLICKISH = new Set(["click", "key", "hover", "write"]);

/**
 * `O dedupe`, second pass: the overlays an older walk minted per repeated click trigger (a column
 * menu per column, per dataview page) collapse into one node per (kind, template, content key). A
 * node qualifies when every edge into it is a click, key, hover or write from a repeated trigger
 * group (role and css template on pages of one template, ROW_MIN or more members on some page);
 * one grid's headers nest a level deeper than another's, so the groups may differ. Column menus whose items differ (a number column's
 * Sum and Avg) have another content key and stay apart. The click sampler is seeded as sampled.
 * Labels lose their generated ids (`stripGenerated`) on every node. `skip`: ids another pass
 * already removes. Returns `{ groups, collapsed, kept, removed, relabelled }`.
 */
export function dedupeClicks(data, { dryRun = false, edgeId, k = ROW_SAMPLE, skip = new Set() } = {}) {
  const N = data.nodes;
  const E = data.edges;
  const OVERLAY = new Set(["overlay", "modal", "menu"]);
  const trigger = (e) => {
    const from = N[e.from];
    const css = e.element?.css;
    if (!from || !css || !CLICKISH.has(e.kind) || (e.kind === "write" && e.via && !CLICKISH.has(e.via))) return null;
    return `${from.template}|${e.element.role}|${repeatGroup(css)}`;
  };
  const members = new Map();
  for (const e of Object.values(E)) {
    const t = trigger(e);
    if (!t) continue;
    const byUrl = members.get(t) ?? members.set(t, new Map()).get(t);
    (byUrl.get(N[e.from].url) ?? byUrl.set(N[e.from].url, new Set()).get(N[e.from].url)).add(e.element.css);
  }
  const big = (t) => [...(members.get(t)?.values() ?? [])].some((s) => s.size >= ROW_MIN);
  const into = new Map();
  for (const e of Object.values(E)) (into.get(e.to) ?? into.set(e.to, []).get(e.to)).push(e);
  const groups = new Map();
  for (const n of Object.values(N)) {
    if (!OVERLAY.has(n.kind) || n.entry || skip.has(n.id)) continue;
    const es = (into.get(n.id) ?? []).filter((e) => !skip.has(e.from));
    if (!es.length) continue;
    const ts = new Set(es.map(trigger));
    if (ts.has(null) || ![...ts].every(big)) continue;
    const gk = `${n.kind}|${n.template}|${n.contentKey ?? normaliseData(stripGenerated(n.label))}`;
    const grp = groups.get(gk) ?? groups.set(gk, { triggers: new Set(), nodes: [] }).get(gk);
    for (const t of ts) grp.triggers.add(t);
    grp.nodes.push(n);
  }
  const out = { groups: 0, collapsed: 0, kept: [], removed: [], relabelled: 0 };
  const mapTo = new Map();
  for (const { triggers, nodes } of groups.values()) {
    if (nodes.length < 2) continue;
    nodes.sort(keeperFirst);
    const [keep, ...rest] = nodes;
    out.groups++;
    out.collapsed += rest.length;
    out.kept.push({ id: keep.id, label: stripGenerated(keep.label), merged: rest.length });
    for (const r of rest) {
      mapTo.set(r.id, keep.id);
      out.removed.push(r.id);
    }
    if (dryRun) continue;
    data.meta.rowSamples ??= {};
    for (const t of triggers) {
      const [tmpl, role, group] = t.split("|");
      const key = `${tmpl}|click|${role}|${group}|`;
      const was = data.meta.rowSamples[key] ?? { tried: 0, leads: [] };
      const lead = `${keep.template}:${keep.contentKey ?? ""}`;
      data.meta.rowSamples[key] = { ...was, tried: Math.max(k, was.tried), leads: was.leads.includes(lead) ? was.leads : [...was.leads, lead] };
    }
    keep.depth = Math.min(...nodes.map((n) => n.depth ?? Infinity));
    keep.info = { ...(keep.info ?? {}), clickGroups: [...triggers].map((t) => t.split("|").slice(1).join("|")), merged: rest.map((r) => r.id) };
  }
  for (const n of Object.values(N)) {
    const clean = stripGenerated(n.label);
    if (clean && clean !== n.label) {
      out.relabelled++;
      if (!dryRun) n.label = clean;
    }
  }
  if (!dryRun) rewire(data, mapTo, edgeId);
  return out;
}
