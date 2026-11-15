// `O relabel --dir <graph> [--node id] [--dry-run]`: bring each node's saved structural labels
// (nodes/<id>/widths.json, what verify's widths check compares) up to the current readLabels
// rules (qa/labels.mjs LABELS_VERSION) without walking the site again.
//
// The node's saved DOM (dom.html) is loaded into a headless page with JavaScript off and every
// request aborted, resized to each width widths.json lists, and read in `pairs` mode: each
// candidate element's version-1 label beside its current label. Offline there are no stylesheets,
// so visibility (which elements were labelled) cannot be judged again; that part is kept from the
// capture, and only each saved label is replaced by what the current rules read from the element
// that carried it. A node is rewritten only when every saved label is accounted for: one that
// the saved DOM does not produce offline (text a stylesheet hid, a subtree rendered after the
// snapshot), or that two elements read differently, leaves the node untouched and marked
// `needs-recapture`, as does a node with no saved DOM. `requeue --needs-recapture` walks those again.
//
// Refuses to run while a walk writes the dir (supervise.pid, walk.lock: walk-lock.mjs), and holds
// walk.lock itself while it writes.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { playwright } from "../lib/pw.mjs";
import { CATEGORIES, LABELS_VERSION, readLabels } from "../qa/labels.mjs";
import { Graph } from "./graph.mjs";
import { open, save } from "./store.mjs";
import { DirBusy, acquire, holders } from "./walk-lock.mjs";

/** The labels version a node's widths.json was read under (unstamped = 1, before the stamp). */
export const labelsVersionOf = (n) => n?.info?.labelsVersion ?? 1;

/** True when the node's saved labels were read under older rules than the current ones. */
export const staleLabels = (n) => labelsVersionOf(n) < LABELS_VERSION;

// Loose key: a stylesheet's text-transform changes innerText's case, and its display rules change
// where innerText puts line breaks ("edit Edit" captured, "editEdit" offline).
const loose = (s) => s.toLowerCase().replace(/\s+/g, "");

/**
 * One width's saved labels mapped through that width's `pairs` (readLabels pairs mode). A saved
 * label is matched to the elements whose version-1 label equals it (exactly, else ignoring case
 * and whitespace, which stylesheets change); it becomes their current label, and is dropped
 * when that is empty. When those elements read differently (a hidden duplicate of a control),
 * the ones visible offline (inline styles, `hidden`, the document's own <style>) decide if they
 * agree; else the capture's own accessibility tree (`axNames`: the names in aria.yml, read by the
 * browser with every stylesheet) decides, when exactly one of the readings is in it. Returns the new labels, how many changed, and the labels that could not be
 * mapped (`unmapped`: no such element; `conflicts`: elements that read differently).
 */
export function remapLabels(saved, pairs, { axNames = null } = {}) {
  const labels = { ...saved };
  const unmapped = [];
  const conflicts = [];
  let changed = 0;
  for (const c of CATEGORIES) {
    if (!Array.isArray(saved?.[c])) continue;
    const index = (rows) => {
      const exact = new Map();
      const near = new Map();
      const add = (m, k, v) => (m.get(k) ?? m.set(k, new Set()).get(k)).add(v);
      for (const [v1, now] of rows) {
        if (!v1) continue;
        add(exact, v1, now);
        add(near, loose(v1), now);
      }
      return (l) => exact.get(l) ?? near.get(loose(l));
    };
    const rows = pairs?.[c] ?? [];
    const every = index(rows);
    const shown = index(rows.filter((r) => r[2] !== false));
    const out = [];
    for (const l of saved[c]) {
      let to = every(l);
      if (to?.size > 1 && shown(l)?.size === 1) to = shown(l);
      if (to?.size > 1 && axNames) {
        const inAx = [...to].filter((x) => axNames.has(loose(x.replace(/^h[\d?] /, ""))));
        if (inAx.length === 1) to = new Set(inAx);
      }
      if (!to) {
        unmapped.push(`${c}|${l}`);
        out.push(l);
      } else if (to.size > 1) {
        conflicts.push(`${c}|${l} -> ${[...to].join(" / ")}`);
        out.push(l);
      } else {
        const [now] = to;
        if (now !== l) changed++;
        if (now) out.push(now);
      }
    }
    labels[c] = out;
  }
  return { labels, changed, unmapped, conflicts };
}

/** The accessible names in a saved aria.yml, normalised like readLabels (digits are `#`). */
export function axNamesOf(yml) {
  const out = new Set();
  for (const m of (yml ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.add(loose(m[1].replace(/\\"/g, '"').replace(/\s+/g, " ").trim().replace(/\d+([.,]\d+)*/g, "#").slice(0, 80)));
  return out;
}

/**
 * Stale-label counts for `status`: nodes whose widths.json predates the current rules, and nodes
 * relabel marked needs-recapture.
 */
export function labelCounts(g, dir) {
  const out = { stale: 0, needsRecapture: 0 };
  for (const n of Object.values(g.data.nodes)) {
    if (n.info?.needsRecapture) out.needsRecapture++;
    if (n.info?.artifacts && staleLabels(n) && existsSync(join(dir, n.info.artifacts, "widths.json"))) out.stale++;
  }
  return out;
}

/** Throws DirBusy when a walk holds `dir`. */
export function assertIdle(dir) {
  const { live } = holders(dir);
  if (live.length) throw new DirBusy(`relabel refused: ${dir} is being written by ${live.map((h) => `${h.cmd} pid ${h.pid} (${h.file})`).join(", ")}; run it when no walk is writing that dir`);
}

/**
 * Relabel every node of `dir` (or only `node`). `dryRun` reads and reports, writes nothing.
 * Returns { relabelled, changedLabels, stamped, needsRecapture: [{ id, reason }], current, noWidths }.
 */
export async function relabel({ dir, node = null, dryRun = false, log = (s) => console.log(s) } = {}) {
  assertIdle(dir);
  const release = dryRun ? () => {} : acquire(dir, "relabel");
  const g = dryRun ? new Graph(JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"))) : open(dir);
  const res = { relabelled: 0, changedLabels: 0, stamped: 0, needsRecapture: [], current: 0, noWidths: 0, scanned: 0 };
  let browser = null;
  try {
    const ids = node ? [node] : Object.keys(g.data.nodes);
    let page = null;
    const pageFor = async () => {
      if (page) return page;
      const { chromium } = await playwright();
      browser = await chromium.launch();
      const ctx = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
      await ctx.route("**/*", (r) => r.abort("blockedbyclient"));
      page = await ctx.newPage();
      return page;
    };
    const mark = (n, reason) => {
      res.needsRecapture.push({ id: n.id, reason });
      if (!dryRun) g.annotate(n.id, { needsRecapture: reason });
      log(`${dryRun ? "would mark" : "marked"} needs-recapture ${n.id} ${n.label ?? ""}: ${reason}`);
    };
    for (const id of ids) {
      const n = g.node(id);
      if (!n.info?.artifacts) continue;
      const art = join(dir, n.info.artifacts);
      const wpath = join(art, "widths.json");
      if (!existsSync(wpath)) {
        res.noWidths++;
        continue;
      }
      if (!staleLabels(n)) {
        res.current++;
        continue;
      }
      res.scanned++;
      const dom = join(art, "dom.html");
      const html = existsSync(dom) ? readFileSync(dom, "utf8") : "";
      if (!html.trim()) {
        mark(n, "no saved DOM (dom.html missing or empty)");
        continue;
      }
      const saved = JSON.parse(readFileSync(wpath, "utf8"));
      const aria = join(art, "aria.yml");
      const axNames = existsSync(aria) ? axNamesOf(readFileSync(aria, "utf8")) : null;
      const p = await pageFor();
      await p.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
      const next = { ...saved, widths: {} };
      let changed = 0;
      const unmapped = [];
      const conflicts = [];
      for (const [w, labels] of Object.entries(saved.widths ?? {})) {
        if (!labels) {
          next.widths[w] = labels;
          continue;
        }
        await p.setViewportSize({ width: Number(w), height: saved.height ?? 900 });
        const pairs = await p.evaluate(readLabels, { scopeCss: saved.scope ?? null, pairs: true });
        if (!pairs) {
          unmapped.push(`scope ${saved.scope} not in the saved DOM at ${w}`);
          break;
        }
        const r = remapLabels(labels, pairs, { axNames });
        next.widths[w] = r.labels;
        changed += r.changed;
        unmapped.push(...r.unmapped.map((x) => `${w}:${x}`));
        conflicts.push(...r.conflicts.map((x) => `${w}:${x}`));
      }
      if (unmapped.length || conflicts.length) {
        const ex = [...conflicts, ...unmapped].slice(0, 3).join("; ");
        mark(n, `labels not readable offline from the saved DOM: ${unmapped.length} unmapped, ${conflicts.length} ambiguous (${ex})`);
        continue;
      }
      if (changed) {
        res.relabelled++;
        res.changedLabels += changed;
      } else res.stamped++;
      log(`${dryRun ? "would " : ""}${changed ? `relabel ${n.id}: ${changed} label(s) changed` : `stamp ${n.id}: labels unchanged`}`);
      if (dryRun) continue;
      if (changed) {
        writeFileSync(`${wpath}.tmp`, JSON.stringify(next));
        renameSync(`${wpath}.tmp`, wpath);
      }
      g.annotate(n.id, { labelsVersion: LABELS_VERSION, needsRecapture: undefined });
      if ((res.relabelled + res.stamped) % 100 === 0) save(g, dir);
    }
    if (!dryRun) save(g, dir);
  } finally {
    await browser?.close().catch(() => {});
    release();
  }
  log(`${dryRun ? "DRY RUN " : ""}RELABEL ${dir}: ${res.scanned} node(s) with stale labels · ${res.relabelled} relabelled (${res.changedLabels} label(s) changed) · ${res.stamped} unchanged, stamped v${LABELS_VERSION} · ${res.needsRecapture.length} need recapture (requeue --needs-recapture) · ${res.current} already current · ${res.noWidths} without widths.json`);
  return res;
}
