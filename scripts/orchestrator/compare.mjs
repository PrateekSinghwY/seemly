// Reference graph vs clone graph: the click-by-click gap list. Pages are matched by their
// path family plus the query keys that select a view (`open_calendar`, `tab`), never by data;
// then, per page, every control the reference walked is looked up in the clone's walk by its
// label (digits normalised, as the clone's data differs from the reference's).
//
// Four findings per page:
//   missing     a control the reference shows that the clone does not render
//   disabled    live on the reference, disabled on the clone
//   dead        on the reference it opened or changed something; on the clone the same control did nothing
//   no-surface  a dialog, menu or state the reference opens from this page that the clone never shows
// plus whole pages the reference has and the clone has none of.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { pathPattern } from "./bound.mjs";

const OPENED = new Set(["navigation", "overlay", "hover-overlay", "state", "popup", "page", "known", "bounded"]);

export const norm = (s) => (s ?? "").toLowerCase().replace(/\s+/g, " ").replace(/\d+([.,]\d+)*/g, "#").trim();

/** Which view of a route a URL is: path family plus the flag-like query keys (values only for short enums). */
export function viewKey(url) {
  const u = new URL(url);
  const keys = [...u.searchParams.keys()].filter((k) => /^(open_|tab$|view$|section$)/.test(k)).sort();
  return `${pathPattern(u.pathname)}${keys.length ? `?${keys.join("&")}` : ""}`;
}

const RANK = { verified: 5, built: 4, closed: 3, expanding: 1, frontier: 1, bounded: 0, gap: 0 };

/** One side's walk, from one graph dir or several (parallel workers over one site): nodes unioned, the most advanced copy kept. */
function load(dirs) {
  const best = new Map();
  for (const dir of [dirs].flat()) {
    const g = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
    for (const n of Object.values(g.nodes)) {
      const prev = best.get(n.id);
      if (!prev || RANK[n.status] > RANK[prev.n.status]) best.set(n.id, { n, dir });
    }
  }
  const pages = new Map();
  for (const { n, dir } of best.values()) {
    if (n.status === "gap" || n.status === "bounded") continue;
    const key = viewKey(n.href ?? n.url);
    const p = pages.get(key) ?? { key, nodes: [], controls: new Map(), surfaces: new Map() };
    pages.set(key, p);
    p.nodes.push(n);
    const inv = n.info?.artifacts && join(dir, n.info.artifacts, "inventory.json");
    if (inv && existsSync(inv)) {
      for (const c of JSON.parse(readFileSync(inv, "utf8")).candidates) {
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
  for (const p of side.pages.values()) {
    for (const [k, c] of p.controls) {
      const prev = controls.get(k);
      controls.set(k, prev ? { ...prev, disabled: prev.disabled && c.disabled, opened: prev.opened || c.opened, inert: prev.inert && c.inert } : c);
    }
    for (const [k, n] of p.surfaces) surfaces.set(k, n);
  }
  return { controls, surfaces };
}

function diffPage(rp, cp, skip = new Set(), skipSurf = new Set()) {
  const row = { key: rp.key, missing: [], disabled: [], dead: [], noSurface: [] };
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

export function compare(refDirs, cloneDirs) {
  const ref = load(refDirs);
  const clone = load(cloneDirs);
  const shell = shellOf(ref);
  const out = { pagesMissing: [], pages: [diffPage(shell, union(clone))] };
  for (const [key, rp] of ref.pages) {
    const cp = clone.pages.get(key);
    if (!cp) {
      out.pagesMissing.push({ key, example: rp.nodes[0].url, kinds: [...new Set(rp.nodes.map((n) => n.kind))] });
      continue;
    }
    const row = diffPage(rp, cp, new Set(shell.controls.keys()), new Set(shell.surfaces.keys()));
    out.pages.push(row);
  }
  return out;
}

export function toMarkdown(r) {
  const L = ["# Reference vs clone: walked-graph diff", ""];
  if (r.pagesMissing.length) {
    L.push("## Views the reference has and the clone has none of", "", "| view | example | kinds |", "|---|---|---|");
    for (const p of r.pagesMissing) L.push(`| \`${p.key}\` | ${p.example} | ${p.kinds.join(", ")} |`);
    L.push("");
  }
  for (const p of r.pages) {
    const n = p.missing.length + p.disabled.length + p.dead.length + p.noSurface.length;
    if (!n) continue;
    L.push(`## \`${p.key}\` (${n})`, "");
    if (p.noSurface.length) L.push(`- **opens on the reference, never on the clone:** ${p.noSurface.join(" · ")}`);
    if (p.dead.length) L.push(`- **does something on the reference, nothing on the clone:** ${p.dead.join(" · ")}`);
    if (p.disabled.length) L.push(`- **disabled on the clone only:** ${p.disabled.join(" · ")}`);
    if (p.missing.length) L.push(`- **not rendered on the clone:** ${p.missing.join(" · ")}`);
    L.push("");
  }
  return L.join("\n");
}
