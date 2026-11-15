// The structural labels of a page, read the same way from the reference and the clone, so a
// diff of two readings is a list of invented or missing bar items, headings, table headers,
// tabs, buttons and field labels. Shared by struct_audit and width_sweep.

/** Widths every page is read at by width_sweep.mjs and Phase D (`verify` widths). */
export const DEFAULT_WIDTHS = [1024, 1280, 1366, 1440, 1536, 1680, 1920, 2560];

/**
 * The rules readLabels reads names by. A widths.json written under an older version holds labels
 * the current rules would not read; the walker stamps `info.labelsVersion` on each node it saves
 * labels for, and `O relabel` recomputes older ones from the saved DOM. Bump it whenever a change
 * here changes what a page's labels are, and teach `pairs` mode the old rule (relabel.mjs).
 *   1  aria-label, else innerText (icon-font ligatures and aria-hidden text included)
 *   2  accessible names: aria-labelledby, aria-label, content minus hidden and icon-font glyphs
 */
export const LABELS_VERSION = 2;

/**
 * In-page (serialised by page.evaluate): self-contained. `scopeCss` reads only inside that
 * element (an overlay); it is `null` when the element is not there.
 *
 * `pairs: true` is for `O relabel` on a saved DOM loaded offline (no stylesheets, so visibility
 * cannot be judged): every candidate element of each category, visible or not, as
 * `[version-1 label, current label, visible offline]`, so a label saved under version 1 can be
 * mapped to the one the current rules read from the same element.
 */
export function readLabels({ scopeCss = null, pairs = false } = {}) {
  const root = scopeCss ? document.querySelector(scopeCss) : document;
  if (!root) return null;
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  // Digits are data, not structure: "3 listings" and "41 listings" are one label.
  const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim().replace(/\d+([.,]\d+)*/g, "#").slice(0, 80);
  // Labels are accessible names, not visible text: an icon-font ligature inside a control
  // ("<span aria-hidden class=material-symbols-outlined>add_circle</span>Create") is not part of
  // the label "Create". Reading innerText made every icon button differ from a reference that
  // renders the same icon another way.
  const ICON_CLASS = /(^|\s)(material-icons|material-symbols)[\w-]*/;
  const ICON_FONT = /material (icons|symbols)|font ?awesome|glyphicons|icomoon|ionicons|bootstrap-icons|codicon/i;
  const isIconFont = (el) => ICON_CLASS.test(el.className?.baseVal ?? el.className ?? "") || ICON_FONT.test(getComputedStyle(el).fontFamily);
  const hidden = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  };
  const byIds = (el, attr) => (el.getAttribute(attr) || "").split(/\s+/).map((id) => id && document.getElementById(id)).filter(Boolean);
  // Name from content: text of the subtree minus aria-hidden / hidden nodes, role=img (named only
  // by its own aria-label), and icon-font glyphs.
  const content = (el, depth = 0) => {
    let out = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.textContent;
      else if (n.nodeType === 1) {
        if (/^(SCRIPT|STYLE|TEMPLATE|INPUT|SELECT|TEXTAREA)$/.test(n.tagName) || hidden(n) || isIconFont(n)) continue;
        const role = n.getAttribute("role");
        if (role === "img") { out += ` ${n.getAttribute("aria-label") || ""} `; continue; }
        if (n.tagName === "IMG") { out += ` ${n.getAttribute("alt") || ""} `; continue; }
        if (n.tagName === "BR") { out += " "; continue; }
        if (depth < 30) out += ` ${n.getAttribute("aria-label") || content(n, depth + 1)} `;
      }
    }
    return out;
  };
  const accName = (el) => {
    const by = byIds(el, "aria-labelledby");
    if (by.length) return by.map((x) => x.getAttribute("aria-label") || content(x)).join(" ");
    return el.getAttribute("aria-label") || content(el);
  };
  // Fallback, only when there is no accessible name: visible text with icon-font glyph text removed.
  const visibleText = (el) => {
    let t = el.innerText || "";
    for (const i of el.querySelectorAll("*")) if (isIconFont(i) && i.textContent.trim()) t = t.replace(i.textContent.trim(), " ");
    return t;
  };
  const name = (el) => norm(norm(accName(el)) || visibleText(el) || el.getAttribute("title") || el.value || el.querySelector("img[alt]")?.alt || "");
  // Version 1 (relabel's `pairs` mode only): aria-label, else innerText, icon glyphs included.
  const name1 = (el) => norm(el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.value || el.querySelector("img[alt]")?.alt || "");
  const field1 = (el) => norm((el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest("label")?.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || "");
  const heading = (f) => (el) => {
    const lvl = el.getAttribute("aria-level") || el.tagName.replace(/^H/, "") || "";
    const t = f(el);
    return t ? `h${/^\d$/.test(lvl) ? lvl : "?"} ${t}` : "";
  };
  const field = (el) => {
    const by = byIds(el, "aria-labelledby");
    const forLabel = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const wrap = el.closest("label");
    return norm((by.length && by.map((x) => x.getAttribute("aria-label") || content(x)).join(" ")) || el.getAttribute("aria-label") || (forLabel && name(forLabel)) || (wrap && name(wrap)) || el.getAttribute("placeholder") || el.name || "");
  };
  const NAV = "nav,header,[role=navigation],[role=banner],[role=menubar],[role=tablist]";
  const inNav = (el) => !!el.closest(NAV);
  // Controls inside table body rows are data (one per listing), not page structure: the
  // structure of a list is its header, toolbar and pager.
  const inRow = (el) => !!el.closest("tbody, [role=rowgroup] [role=row], [role=gridcell]");
  // Per category: its candidate elements, the current rule, the version-1 rule.
  const cats = {
    headings: [[...root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")], heading(name), heading(name1)],
    nav: [[...root.querySelectorAll(`a[href],button,[role=menuitem],[role=link],[role=button]`)].filter((el) => inNav(el) && el.getAttribute("role") !== "tab"), name, name1],
    tabs: [[...root.querySelectorAll("[role=tab]")], name, name1],
    buttons: [[...root.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")].filter((el) => !inNav(el) && !inRow(el)), name, name1],
    tableHeaders: [[...root.querySelectorAll("th,[role=columnheader]")], name, name1],
    fields: [[...root.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((el) => !inRow(el)), field, field1],
  };
  const out = {};
  for (const [k, [els, f, f1]] of Object.entries(cats)) out[k] = pairs ? els.map((el) => [f1(el), f(el), visible(el)]) : els.filter(visible).map(f).filter(Boolean);
  if (pairs) return out;
  out.overflowX = scopeCss ? root.scrollWidth > root.clientWidth + 1 : document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
  return out;
}

export const CATEGORIES = ["headings", "nav", "tabs", "buttons", "tableHeaders", "fields"];

/**
 * Per category: labels the reference has and the clone lacks (`missing`), labels only the clone
 * has (`extra`, invented UI), and `order` when both hold the same labels in a different order.
 * `allow` is a set of "category|label" pairs waived with a written reason.
 */
export function diffLabels(ref, clone, allow = new Set()) {
  const out = {};
  for (const c of CATEGORIES) {
    const a = ref[c] ?? [];
    const b = clone[c] ?? [];
    const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
    const ca = count(a);
    const cb = count(b);
    const missing = [];
    const extra = [];
    for (const [k, n] of ca) for (let i = 0; i < n - (cb.get(k) ?? 0); i++) if (!allow.has(`${c}|${k}`)) missing.push(k);
    for (const [k, n] of cb) for (let i = 0; i < n - (ca.get(k) ?? 0); i++) if (!allow.has(`${c}|${k}`)) extra.push(k);
    const order = !missing.length && !extra.length && a.join("\u0000") !== b.join("\u0000");
    if (missing.length || extra.length || order) out[c] = { missing, extra, order };
  }
  if (ref.overflowX !== clone.overflowX) out.overflowX = { ref: ref.overflowX, clone: clone.overflowX };
  return out;
}

export function slug(url) {
  const u = new URL(url);
  return (u.pathname + u.search).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

/** `--ref a --clone b`, or `--pairs file.json` holding [{ ref, clone }]. */
export async function pairsFrom(o) {
  if (o.pairs) {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(o.pairs, "utf8"));
  }
  if (!o.ref || !o.clone) throw new Error("give --ref <url> --clone <url>, or --pairs <file.json>");
  return [{ ref: o.ref, clone: o.clone }];
}

export async function allowFrom(file) {
  if (!file) return new Set();
  const { readFileSync } = await import("node:fs");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  for (const r of rows) if (!r.reason) throw new Error(`allow entry ${r.category}|${r.label} has no reason`);
  return new Set(rows.map((r) => `${r.category}|${r.label}`));
}
