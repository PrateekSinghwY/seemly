// The structural labels of a page, read the same way from the reference and the clone, so a
// diff of two readings is a list of invented or missing bar items, headings, table headers,
// tabs, buttons and field labels. Shared by struct_audit and width_sweep.

/** In-page (serialised by page.evaluate): self-contained. */
export function readLabels() {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  // Digits are data, not structure: "3 listings" and "41 listings" are one label.
  const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim().replace(/\d+([.,]\d+)*/g, "#").slice(0, 80);
  const name = (el) => norm(el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || el.value || el.querySelector("img[alt]")?.alt || "");
  const all = (sel, f = name, within = document) => [...within.querySelectorAll(sel)].filter(visible).map(f).filter(Boolean);
  const NAV = "nav,header,[role=navigation],[role=banner],[role=menubar],[role=tablist]";
  const inNav = (el) => !!el.closest(NAV);
  // Controls inside table body rows are data (one per listing), not page structure: the
  // structure of a list is its header, toolbar and pager.
  const inRow = (el) => !!el.closest("tbody, [role=rowgroup] [role=row], [role=gridcell]");
  return {
    headings: all("h1,h2,h3,h4,h5,h6,[role=heading]", (el) => {
      const lvl = el.getAttribute("aria-level") || el.tagName.replace(/^H/, "") || "";
      const t = name(el);
      return t ? `h${/^\d$/.test(lvl) ? lvl : "?"} ${t}` : "";
    }),
    nav: [...document.querySelectorAll(`a[href],button,[role=menuitem],[role=link],[role=button]`)].filter((el) => visible(el) && inNav(el) && el.getAttribute("role") !== "tab").map(name).filter(Boolean),
    tabs: all("[role=tab]"),
    buttons: [...document.querySelectorAll("button,[role=button],input[type=submit],input[type=button]")].filter((el) => visible(el) && !inNav(el) && !inRow(el)).map(name).filter(Boolean),
    tableHeaders: all("th,[role=columnheader]"),
    fields: [...document.querySelectorAll("input:not([type=hidden]),select,textarea")].filter((el) => visible(el) && !inRow(el)).map((el) =>
      norm((el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest("label")?.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.name || ""),
    ).filter(Boolean),
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
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
