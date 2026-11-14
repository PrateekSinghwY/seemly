// Every interaction kind besides a plain click, as first-class edges (SKILL.md section 4,
// reference/graph.md "Interaction kinds"). explore.mjs fires them on every node after the clicks;
// verify.mjs replays them on the clone; compare.mjs `edgeDiff` judges them edge by edge.
//
//   contextmenu  a real right-click on every element with a contextmenu listener, plus grid
//                cells, rows and chips (one per distinct row template, more while they open)
//   dblclick     elements with a dblclick listener, plus grid cells
//   key          documented shortcuts (keyboards.json, else a probe set when the page has a
//                global keydown listener) once per template; Enter/Space on each control that
//                has a click edge, once per template, to see it activates the same way
//   drag         draggable elements, sliders, splitters and resize handles, by a fixed offset
//   input        a form filled with valid synthetic values, or one field with one invalid value
//                per constraint; a search box gets one short synthetic query instead
//   submit       a form submitted empty, valid, or with one invalid value (a write is aborted on
//                the reference and queued, like a click's)
//   upload       a file input: its accept list and size limit read off the UI; with writes
//                allowed, a tiny accepted fixture file and a rejected one
//
// Listener detection is an instrumented addEventListener (`LISTENER_HOOK`, an init script) plus
// the `on<type>` properties. Every in-page function here is serialised into the page by
// `page.evaluate`, so each is self-contained.

import { createHash } from "node:crypto";

import { STATE_BOUND, repeatGroup } from "./bound.mjs";
import { classify } from "./safety.mjs";

/** The kinds an element can have an outcome for, in the order the walker fires them. */
export const INTERACTION_KINDS = ["click", "contextmenu", "dblclick", "key", "drag", "input", "submit", "upload"];

/** How a report names each kind ("right-click on 'X' opens nothing on the clone"). */
export const VERB = { click: "click", contextmenu: "right-click", dblclick: "double-click", key: "key", drag: "drag", input: "typing", submit: "submit", upload: "upload" };

/** Conventional shortcuts tried when a page listens for keys globally and no keyboards.json was given. */
export const PROBE_KEYS = ["?", "/", "mod+k", "mod+/"];

/** Offset of every drag, in CSS px along the handle's axis. */
export const DRAG_BY = 60;

/** Invalid cases tried per form before the rest are recorded as sampled out. */
export const FORM_CASES = STATE_BOUND;

/** Unfired reasons this pass adds to explore.mjs's (`nodeInvariant`, `interactionInvariant`). */
export const INTERACTION_UNFIRED = new Set(["upload-needs-writes", "not-focusable", "submit-disabled", "no-submit"]);

/**
 * Init script: record the event types every EventTarget listens for, in a WeakMap the probes
 * read (`window.__seemlyL`). Installed before any page script, on the reference and the clone.
 */
export const LISTENER_HOOK = `(() => {
  if (window.__seemlyL) return;
  const seen = new WeakMap();
  Object.defineProperty(window, "__seemlyL", { value: seen });
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      let s = seen.get(this);
      if (!s) seen.set(this, (s = new Set()));
      s.add(String(type));
    } catch {}
    return add.call(this, type, fn, opts);
  };
})();`;

// ---------- in the page ----------

/**
 * What on the page (or inside `scopeCss`) takes each interaction kind: right-click and
 * double-click targets, drag handles, form groups with their fields and constraints, file inputs,
 * and whether anything listens for keys globally.
 */
export function interactionTargets({ scopeCss = null, max = 300 } = {}) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const cssPath = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id && /^[A-Za-z][\w-]{0,40}$/.test(e.id) && !/\d{3,}/.test(e.id) && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(e.id)}`);
        break;
      }
      const tag = e.tagName.toLowerCase();
      const sibs = e.parentElement ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(e) + 1})` : tag);
    }
    return parts.join(" > ");
  };
  const labelOf = (el) => text(el.labels?.[0]?.innerText ?? "", 80);
  const nameOf = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    const byId = lb ? lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ") : "";
    return text(el.getAttribute("aria-label") || byId || labelOf(el) || (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? "" : el.innerText) || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "");
  };
  const IMPLICIT = { A: "link", BUTTON: "button", SUMMARY: "button", SELECT: "combobox", TEXTAREA: "textbox", TR: "row", TD: "cell", FORM: "form", FIELDSET: "group" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider", search: "searchbox", file: "button" }[t] ?? "textbox";
    }
    return IMPLICIT[el.tagName] ?? "generic";
  };
  const L = window.__seemlyL;
  const has = (el, type) => !!L?.get(el)?.has(type) || typeof el[`on${type}`] === "function";
  const INTERACTIVE = "a[href],button,input,select,textarea,[role=button],[role=link],[tabindex]";
  // A listener on a container of many controls is a delegated one (a framework root): not a target.
  const tooBig = (el) => el === document.body || el === document.documentElement || el.querySelectorAll(INTERACTIVE).length > 8;
  const rowSig = (el) => {
    const row = el.closest("[role=row],tr,li") || el;
    return fnv([...row.children].map((c) => `${c.tagName}${c.getAttribute("role") ?? ""}`).join(","));
  };
  const seen = new Map();
  const desc = (el, why) => {
    const role = roleOf(el);
    const name = nameOf(el);
    const k = `${role}|${name}`;
    const nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    const r = el.getBoundingClientRect();
    return { role, name, nth, css: cssPath(el), why, rowSig: rowSig(el), orientation: el.getAttribute("aria-orientation"), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  };
  const root = (scopeCss && document.querySelector(scopeCss)) || document.body;
  const all = [...root.querySelectorAll("*")].filter((el) => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  });

  const CELL = "[role=gridcell]";
  const ROW = "[role=row]:not(:has([role=gridcell],[role=columnheader])),tbody > tr";
  const CHIP = "[class*=chip i],[class*=pill i]";
  const contextmenu = [];
  const dblclick = [];
  const drag = [];
  const RESIZE = /^(grab|grabbing|move|col-resize|row-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|[nsew]{1,2}-resize)$/;
  for (const el of all) {
    if (contextmenu.length < max) {
      if (has(el, "contextmenu") && !tooBig(el)) contextmenu.push(desc(el, "listener"));
      else if (el.matches(CELL)) contextmenu.push(desc(el, "cell"));
      else if (el.matches(ROW)) contextmenu.push(desc(el, "row"));
      else if (el.matches(CHIP) && !el.querySelector(CHIP)) contextmenu.push(desc(el, "chip"));
    }
    if (dblclick.length < max) {
      if (has(el, "dblclick") && !tooBig(el)) dblclick.push(desc(el, "listener"));
      else if (el.matches(CELL)) dblclick.push(desc(el, "cell"));
    }
    if (drag.length < max) {
      const r = el.getBoundingClientRect();
      if (el.getAttribute("draggable") === "true") drag.push(desc(el, "draggable"));
      else if (el.matches("[role=slider],input[type=range],[role=separator][tabindex]")) drag.push(desc(el, "handle"));
      else if (has(el, "dragstart") && !tooBig(el)) drag.push(desc(el, "listener"));
      else if (r.width * r.height < 20000 && RESIZE.test(getComputedStyle(el).cursor) && !RESIZE.test(getComputedStyle(el.parentElement ?? el).cursor)) drag.push(desc(el, "cursor"));
    }
  }

  // Forms: <form>, [role=form|search], else fields grouped by the nearest ancestor holding a button.
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "file"]);
  const isField = (el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && !SKIP_TYPES.has((el.getAttribute("type") || "").toLowerCase()) && !el.disabled && visible(el);
  const fieldOf = (el) => {
    const type = el.tagName === "INPUT" ? (el.getAttribute("type") || "text").toLowerCase() : el.tagName.toLowerCase();
    const num = (a) => (el.getAttribute(a) === null || el.getAttribute(a) === "" ? null : el.getAttribute(a));
    return {
      css: cssPath(el), role: roleOf(el), name: nameOf(el), type,
      required: el.required || el.getAttribute("aria-required") === "true",
      pattern: num("pattern"), min: num("min"), max: num("max"), step: num("step"),
      minLength: el.minLength > 0 ? el.minLength : null, maxLength: el.maxLength > 0 ? el.maxLength : null,
      placeholder: el.getAttribute("placeholder"),
      options: el.tagName === "SELECT" ? [...el.options].map((o) => ({ value: o.value, label: text(o.textContent, 60), disabled: o.disabled })) : null,
    };
  };
  const groups = [];
  const taken = new Set();
  const roots = [...root.querySelectorAll("form,[role=form],[role=search]")].filter((f) => visible(f) && !f.parentElement?.closest("form,[role=form],[role=search]"));
  const orphans = [...root.querySelectorAll("input,select,textarea")].filter((f) => isField(f) && !roots.some((r) => r.contains(f)));
  for (const f of orphans) {
    let g = f.parentElement;
    for (let i = 0; i < 4 && g && g !== root && !g.querySelector("button,[role=button],input[type=submit]"); i++) g = g.parentElement;
    const grp = g && g.querySelector("button,[role=button],input[type=submit]") ? g : f.parentElement;
    if (grp && !roots.includes(grp)) roots.push(grp);
  }
  for (const g of roots) {
    if (groups.length >= 20) break;
    const fields = [...g.querySelectorAll("input,select,textarea")].filter((f) => isField(f) && !taken.has(f));
    if (!fields.length) continue;
    fields.forEach((f) => taken.add(f));
    const inForm = g.tagName === "FORM";
    const buttons = [...g.querySelectorAll("button,[role=button],input[type=submit]")].filter(visible);
    const sub = (inForm && buttons.find((b) => b.type === "submit")) || buttons.filter((b) => !/^(cancel|close|clear|reset|back)$/i.test(nameOf(b))).pop() || null;
    const searchy = (el) => /search|filter|find|query/i.test(`${el.getAttribute("type") ?? ""} ${el.getAttribute("role") ?? ""} ${nameOf(el)} ${el.getAttribute("placeholder") ?? ""}`);
    const search = g.getAttribute("role") === "search" || (fields.length <= 2 && fields.some(searchy));
    groups.push({
      css: cssPath(g), role: roleOf(g), search,
      name: text(g.getAttribute("aria-label") || g.querySelector("legend,h1,h2,h3,h4")?.innerText || (sub ? nameOf(sub) : "") || nameOf(fields[0]), 60),
      fields: fields.slice(0, 40).map(fieldOf),
      submit: sub ? { css: cssPath(sub), role: roleOf(sub), name: nameOf(sub), disabled: sub.disabled === true || sub.getAttribute("aria-disabled") === "true" } : null,
    });
  }

  // File inputs, visible or not (a styled label usually hides the real input).
  const SIZE = /(\d+(?:[.,]\d+)?)\s*(bytes|KB|MB|GB)\b/i;
  const files = [...root.querySelectorAll("input[type=file]")].slice(0, 20).map((el) => {
    let copy = "";
    for (let e = el.labels?.[0] ?? el.parentElement, i = 0; e && i < 4 && !SIZE.test(copy); e = e.parentElement, i++) copy = e.innerText ?? "";
    const size = copy.match(SIZE);
    return { css: cssPath(el), role: "button", name: nameOf(el) || "file", accept: (el.getAttribute("accept") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean), multiple: el.multiple, maxSize: size ? `${size[1]} ${size[2].toUpperCase()}` : null };
  });

  const globalKeys = [window, document, document.body, document.documentElement].some((t) => t && ["keydown", "keyup", "keypress"].some((k) => has(t, k)));
  return { contextmenu, dblclick, drag, forms: groups, files, globalKeys };
}

/**
 * A form group's validation state: invalid fields (aria-invalid or :invalid), visible messages
 * (alerts, error text, what fields are described by) and whether its submit is disabled. Read
 * before and after an input or submit, so a change is a state even when the skeleton is not.
 */
export function formState(css) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  const grp = css ? document.querySelector(css) : null;
  const scope = grp?.closest("form") ?? grp ?? document.body;
  const fields = [...scope.querySelectorAll("input,select,textarea")];
  const nm = (f) => f.getAttribute("aria-label") || f.labels?.[0]?.innerText?.trim() || f.name || f.id;
  const invalid = fields.filter((f) => f.getAttribute("aria-invalid") === "true" || f.matches(":invalid")).map(nm).sort();
  const ids = fields.flatMap((f) => [...(f.getAttribute("aria-describedby") ?? "").split(/\s+/), f.getAttribute("aria-errormessage") ?? ""]).filter(Boolean);
  const els = new Set([...scope.querySelectorAll("[role=alert],[aria-live],[class*=error i],[class*=invalid i]"), ...document.querySelectorAll("[role=alert]"), ...ids.map((id) => document.getElementById(id)).filter(Boolean)]);
  const messages = [...els].filter(visible).map((e) => text(e.innerText)).filter(Boolean).sort();
  const sub = scope.querySelector("button[type=submit],input[type=submit]") ?? [...scope.querySelectorAll("button,[role=button]")].pop();
  const submitDisabled = !!sub && (sub.disabled === true || sub.getAttribute("aria-disabled") === "true");
  return { invalid, messages, submitDisabled, digest: JSON.stringify([invalid, messages, submitDisabled]) };
}

/** An element's box, value and aria-valuenow: what a drag changes when the skeleton does not. */
export function geometry(css) {
  const el = document.querySelector(css);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const parent = el.parentElement?.getBoundingClientRect();
  const sib = [...(el.parentElement?.children ?? [])].map((c) => {
    const b = c.getBoundingClientRect();
    return `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
  });
  return JSON.stringify([Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), el.getAttribute("aria-valuenow"), el.value ?? null, parent && Math.round(parent.width), sib]);
}

/** The text around an element (its form, section or dialog): what an upload changes. */
export function textAround(css) {
  const el = document.querySelector(css);
  const box = el?.closest("form,section,[role=dialog],main") ?? document.body;
  return (box.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

/** The focused element as `role "name"` (digits as `#`), and whether it is inside `scopeCss`. */
export function describeActive(scopeCss) {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement || el.dataset.seemlySentinel) return null;
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const role = el.getAttribute("role") || { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" }[el.tagName] || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", range: "slider" }[(el.type || "").toLowerCase()] ?? "textbox") : el.tagName.toLowerCase());
  const name = text(el.getAttribute("aria-label") || el.labels?.[0]?.innerText || (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) ? "" : el.innerText) || el.getAttribute("title") || el.getAttribute("placeholder") || "").replace(/\d+([.,]\d+)*/g, "#");
  const scope = scopeCss ? document.querySelector(scopeCss) : null;
  const path = [];
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) path.unshift(`${e.tagName}${[...(e.parentElement?.children ?? [])].indexOf(e)}`);
  return { label: `${role}${name ? ` "${name}"` : ""}`, key: path.join("/"), inScope: !scope || scope.contains(el) };
}

// ---------- in node: focus order ----------

/**
 * The Tab order of the page (or of the overlay `scopeCss`): `role "name"` per stop, from a
 * sentinel at the top of the body, until focus leaves the document or comes round again.
 */
export async function focusOrder(page, scopeCss = null, max = 60) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    const s = document.createElement("span");
    s.tabIndex = -1;
    s.dataset.seemlySentinel = "1";
    document.body.prepend(s);
    s.focus();
  });
  const order = [];
  const keys = new Set();
  let truncated = false;
  try {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press("Tab");
      const d = await page.evaluate(describeActive, scopeCss).catch(() => null);
      if (!d || keys.has(d.key)) break;
      keys.add(d.key);
      if (d.inScope) order.push(d.label);
      if (i === max - 1) truncated = true;
    }
  } finally {
    await page.evaluate(() => {
      document.activeElement?.blur?.();
      document.querySelectorAll("[data-seemly-sentinel]").forEach((s) => s.remove());
    }).catch(() => {});
  }
  return { scope: scopeCss, order, truncated };
}

/** First difference between two focus orders, or null when they are the same. */
export function focusDiff(ref, clone) {
  const a = ref?.order ?? [];
  const b = clone?.order ?? [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return { stop: i + 1, ref: a[i] ?? "(end)", clone: b[i] ?? "(end)" };
  return null;
}

// ---------- keys ----------

const NAMED = { esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", space: "Space", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", del: "Delete", delete: "Delete", backspace: "Backspace", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", plus: "+" };
const MODS = { mod: "ControlOrMeta", cmd: "Meta", command: "Meta", meta: "Meta", "⌘": "Meta", ctrl: "Control", control: "Control", "^": "Control", alt: "Alt", option: "Alt", opt: "Alt", "⌥": "Alt", shift: "Shift", "⇧": "Shift" };

/** A shortcut as keyboards.json writes it (`mod+k`, `⌘K`, `Alt+M`, `g i`) as Playwright key presses. */
export function pwKeys(keys) {
  return String(keys)
    .trim()
    .split(/\s+(?![+])/)
    .map((chord) => {
      const parts = chord.replace(/([⌘⌥⇧^])(?=.)/g, "$1+").split(/\+(?!$)/).filter(Boolean);
      return parts
        .map((p, i) => {
          const low = p.toLowerCase();
          if (i < parts.length - 1 && MODS[low]) return MODS[low];
          if (NAMED[low]) return NAMED[low];
          if (/^f\d{1,2}$/i.test(p)) return p.toUpperCase();
          return p.length === 1 ? p.toLowerCase() : p;
        })
        .join("+");
    });
}

/** The shortcuts of a keyboards.json document: `{ keys, action, implemented, reason }` each. */
export function readShortcuts(doc) {
  return (doc?.shortcuts ?? []).filter((s) => s?.keys).map((s) => ({ keys: String(s.keys), action: s.action ?? "", implemented: s.implemented !== false, reason: s.reason ?? null }));
}

// ---------- synthetic values ----------

/** A string matching a simple pattern: classes, escapes, literals, groups of alternatives, quantifiers. */
export function patternSample(pattern) {
  let out = "";
  const src = String(pattern);
  let i = 0;
  const atom = () => {
    const c = src[i];
    if (c === "\\") {
      const e = src[i + 1];
      i += 2;
      return { d: "0", w: "a", s: " ", D: "a", W: "-", S: "a" }[e] ?? e;
    }
    if (c === "[") {
      const end = src.indexOf("]", i + 1);
      const body = src.slice(i + 1, end);
      i = end + 1;
      if (body.startsWith("^")) return "a";
      const m = body.match(/^\\?(.)/);
      return m[1] === "d" && body.startsWith("\\") ? "0" : m[1];
    }
    if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth) {
        if (src[j] === "\\") j++;
        else if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      }
      const inner = src.slice(i + 1, j - 1).replace(/^\?:/, "");
      i = j;
      return patternSample(inner.split("|")[0]);
    }
    i++;
    return c === "." ? "a" : c;
  };
  while (i < src.length) {
    if (src[i] === "^" || src[i] === "$") {
      i++;
      continue;
    }
    if (src[i] === "|") break;
    const a = atom();
    const q = src.slice(i).match(/^(\{(\d+)(,(\d*))?\}|[+*?])/);
    let n = 1;
    if (q) {
      i += q[0].length;
      n = q[1] === "*" || q[1] === "?" ? 0 : q[1] === "+" ? 1 : +q[2];
    }
    out += a.repeat(n);
  }
  return out;
}

const fit = (s, f) => {
  let v = s;
  if (f.minLength && v.length < f.minLength) v = v.padEnd(f.minLength, "x");
  if (f.maxLength && v.length > f.maxLength) v = v.slice(0, f.maxLength);
  return v;
};
const matches = (v, pattern) => {
  try {
    return new RegExp(`^(?:${pattern})$`, "v").test(v);
  } catch {
    try {
      return new RegExp(`^(?:${pattern})$`).test(v);
    } catch {
      return true;
    }
  }
};

/**
 * A type-appropriate valid value for one field descriptor (from `interactionTargets`), as
 * `{ how: fill | select | check, value }`: its type, options, min/max, pattern and placeholder
 * decide it. Values are synthetic (reserved documentation domain and number range).
 */
export function syntheticValue(f) {
  if (f.type === "checkbox" || f.type === "radio") return { how: "check", value: true };
  if (f.options) {
    const o = f.options.find((x) => !x.disabled && x.value !== "") ?? f.options[0];
    return { how: "select", value: o?.value ?? "" };
  }
  const num = (x, d) => (x === null || x === undefined || x === "" || Number.isNaN(+x) ? d : +x);
  const byType = {
    email: "alex.doe@example.com", tel: "+1 555 0100", url: "https://example.com", password: "Example-pass1", search: "a",
    date: f.min ?? "2026-01-15", time: f.min ?? "09:00", "datetime-local": f.min ?? "2026-01-15T09:00", month: f.min ?? "2026-01", week: f.min ?? "2026-W03", color: "#336699",
  };
  if (f.type === "number" || f.type === "range") {
    const lo = num(f.min, 1);
    const hi = num(f.max, lo + 10);
    return { how: "fill", value: String(Math.min(Math.max(lo, 1), hi)) };
  }
  if (byType[f.type]) return { how: "fill", value: byType[f.type] };
  if (f.pattern) {
    const tries = [f.placeholder, patternSample(f.pattern), "A1", "ABC", "abc", "123", "AB-1234", "2026-01-15", "09:00"].filter(Boolean);
    const hit = tries.find((v) => matches(v, f.pattern));
    if (hit) return { how: "fill", value: hit };
  }
  return { how: "fill", value: fit(/name/i.test(f.name) ? "Alex Doe" : "Sample text", f) };
}

/** One invalid value per constraint the field declares: `[{ constraint, how, value }]`. */
export function invalidValues(f) {
  const out = [];
  if (f.type === "checkbox" || f.type === "radio") return f.required ? [{ constraint: "required", how: "uncheck", value: false }] : [];
  if (f.required) out.push({ constraint: "required", how: f.options ? "select" : "fill", value: "" });
  if (f.options) return out;
  if (f.pattern) {
    const bad = ["!!", "zz zz", "0"].find((v) => !matches(v, f.pattern));
    if (bad) out.push({ constraint: "pattern", how: "fill", value: bad });
  }
  if (f.minLength > 1) out.push({ constraint: "minlength", how: "fill", value: "a".repeat(f.minLength - 1) });
  if ((f.type === "number" || f.type === "range") && f.min !== null && f.min !== undefined) out.push({ constraint: "min", how: "fill", value: String(+f.min - 1) });
  if ((f.type === "number" || f.type === "range") && f.max !== null && f.max !== undefined) out.push({ constraint: "max", how: "fill", value: String(+f.max + 1) });
  if (f.type === "email") out.push({ constraint: "type", how: "fill", value: "not-an-email" });
  if (f.type === "url") out.push({ constraint: "type", how: "fill", value: "not a url" });
  return out;
}

// ---------- fixture files ----------

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==", "base64");
const KINDS = [
  { ext: ".csv", mime: "text/csv", body: () => Buffer.from("a,b\n1,2\n") },
  { ext: ".png", mime: "image/png", body: () => PNG_1PX },
  { ext: ".txt", mime: "text/plain", body: () => Buffer.from("sample\n") },
  { ext: ".pdf", mime: "application/pdf", body: () => Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n") },
  { ext: ".json", mime: "application/json", body: () => Buffer.from("{}\n") },
  { ext: ".jpg", mime: "image/jpeg", body: () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
  { ext: ".bin", mime: "application/octet-stream", body: () => Buffer.from([0, 1, 2, 3]) },
];
const acceptsKind = (accept, k) => !accept.length || accept.some((a) => a === k.ext || a === k.mime || (a.endsWith("/*") && k.mime.startsWith(a.slice(0, -1))));

/**
 * A tiny upload fixture for an accept list: one it accepts (`ok`), or one it rejects (null when
 * it accepts anything). Shaped for Playwright `setInputFiles`.
 */
export function fixtureFile(accept = [], ok = true) {
  const k = KINDS.find((x) => acceptsKind(accept, x) === ok);
  return k ? { name: `sample${k.ext}`, mimeType: k.mime, buffer: k.body() } : null;
}

// ---------- replay (the walker's reach and verify's reachClone) ----------

/** Type a list of `{ css, role, name, how, value }` into the page, then blur. */
export async function applyFills(page, fills, locate) {
  for (const f of fills ?? []) {
    const l = (f.css && (await page.locator(`css=${f.css}`).count()) === 1 ? page.locator(`css=${f.css}`) : null) ?? (await locate(page, f));
    if (!l) throw new Error(`replay: field "${f.name || f.css}" not found`);
    if (f.how === "select") await l.selectOption(String(f.value), { timeout: 4000 });
    else if (f.how === "check") await l.check({ timeout: 4000 });
    else if (f.how === "uncheck") await l.uncheck({ timeout: 4000 });
    else await l.fill(String(f.value), { timeout: 4000 });
  }
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
}

/** A pointer drag of `l` by (dx, dy) in small steps, as a person does it. */
export async function dragBy(page, l, dx = DRAG_BY, dy = 0) {
  const b = await l.boundingBox();
  if (!b) throw new Error("drag: the handle has no box");
  const x = b.x + b.width / 2;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Perform one interaction kind on a located element (the act itself, nothing observed). */
export async function perform(page, kind, el, l, locate) {
  if (kind === "hover") return l.hover({ timeout: 4000 });
  if (kind === "contextmenu") return l.click({ button: "right", timeout: 4000 });
  if (kind === "dblclick") return l.dblclick({ timeout: 4000 });
  if (kind === "drag") return dragBy(page, l, el.dx ?? DRAG_BY, el.dy ?? 0);
  if (kind === "key") {
    if (el.role === "shortcut") await page.evaluate(() => document.activeElement?.blur?.());
    else await l.focus({ timeout: 4000 });
    for (const k of pwKeys(el.key)) await page.keyboard.press(k);
    return;
  }
  if (kind === "input" || kind === "submit") {
    await applyFills(page, el.fills, locate);
    if (kind === "submit") return l.click({ timeout: 4000 });
    if (el.enter) {
      const f = el.fills?.[0];
      const field = f && ((f.css && (await page.locator(`css=${f.css}`).count()) === 1 ? page.locator(`css=${f.css}`) : null) ?? (await locate(page, f)));
      if (field) await field.press("Enter");
    }
    return;
  }
  if (kind === "upload") {
    const file = fixtureFile(el.accept ?? [], el.case !== "rejected");
    if (!file) throw new Error("upload: no fixture for this accept list");
    return l.setInputFiles(file, { timeout: 4000 });
  }
  return l.click({ timeout: 4000 });
}

/** The element an edge acts on: a form group's input needs none, an upload's input may be hidden. */
export async function locateFor(page, kind, el, locate) {
  if (kind === "key" && el.role === "shortcut") return page.locator("body");
  if (kind === "input") return page.locator("body");
  if (kind === "upload") {
    const l = el.css ? page.locator(`css=${el.css}`) : null;
    if (l && (await l.count()) === 1) return l;
    return el.name ? page.getByLabel(el.name, { exact: true }).first() : null;
  }
  return locate(page, el);
}

/** Replay one edge (any kind) on `page`. `write` edges are never on a replay route. */
export async function replayEdge(page, { kind, element: el, via }, locate) {
  const k = kind === "write" ? (via ?? "click") : kind === "navigation" || kind === "keyboard" ? "click" : kind;
  const l = await locateFor(page, k, el, locate);
  if (!l) throw new Error(`replay: "${el.name || el.css}" not found`);
  await perform(page, k, el, l, locate);
}

// ---------- the pass ----------

/** Same key on both sides of a compare: kind, key or case, role, name with digits normalised. */
export const rowKey = (r) => `${r.kind}|${r.key ?? ""}|${r.case ?? ""}|${r.role}|${String(r.name ?? "").toLowerCase().replace(/\s+/g, " ").replace(/\d+([.,]\d+)*/g, "#").trim()}`;

const ACTIVATE_ROLES = new Set(["button", "tab", "menuitem", "menuitemradio", "menuitemcheckbox", "switch", "checkbox", "radio", "treeitem", "option", "gridcell", "row", "link", "combobox", "generic"]);
const SPACE_ROLES = new Set(["checkbox", "switch", "radio"]);

/**
 * Fire every interaction kind besides the click on one node. `ctx` comes from explore.mjs:
 *   page, n, scopeCss          the node, reached, its overlay scope
 *   outcomes                   the click rows (candidates with what each did)
 *   fire(kind, c, opts)        restore the pre-state, act, observe; returns the row's result
 *   reset()                    a fresh reach of the node (form values and drags do not restore)
 *   inherited                  keys the parent node already fired (a state re-exposes them)
 *   seen, templateSampled      template sampling, as for clicks
 *   shortcuts                  documented shortcuts (readShortcuts), or null
 *   writesAllowed              --allow-post given: uploads fire
 *   risky, pending             the click loop's safety rule and its pending-writes writer
 *   sample                     repeated siblings tried before sampling stops (SAMPLE)
 * Returns `{ rows, targets, keys }`: one row per target, the keys this node fired.
 */
export async function runInteractions(ctx) {
  const { page, n, scopeCss, outcomes, fire, reset, inherited = new Set(), seen = new Set(), templateSampled = false, shortcuts = null, writesAllowed = false, risky = "record", pending = () => {}, sample = 5 } = ctx;
  const t = await page.evaluate(interactionTargets, { scopeCss });
  const rows = [];
  const keys = [];
  const norm = (s) => String(s ?? "").replace(/\d+([.,]\d+)*/g, "#");
  /** Inherited, template-seen, or null when this target fires here. */
  const gate = (kind, c, extra = "") => {
    const key = `${kind}|${extra}|${c.role}|${c.name}|${repeatGroup(c.css ?? "")}`;
    keys.push(key);
    if (inherited.has(key)) return "inherited";
    const nk = `${kind}|${extra}|${c.role}|${norm(c.name)}|${repeatGroup(c.css ?? "")}`;
    if (templateSampled && seen.has(nk)) return "template-seen";
    seen.add(nk);
    return null;
  };
  const row = (kind, c, extra) => ({ kind, role: c.role, name: c.name, css: c.css, ...extra });
  const push = (r, res) => rows.push({ ...r, ...res, to: res.children ?? [] });
  const unfired = (r, reason, extra = {}) => rows.push({ ...r, ...extra, outcome: reason, unfired: reason, to: [] });

  // right-click and double-click: grouped by row template; a group of heuristic targets (cells,
  // rows, chips with no listener of their own) is probed once and walked further only when that
  // opened something; a larger group than STATE_BOUND is sampled like repeated clicks
  for (const kind of ["contextmenu", "dblclick"]) {
    const groups = new Map();
    for (const c of t[kind]) {
      const k = `${repeatGroup(c.css)}|${c.rowSig}`;
      (groups.get(k) ?? groups.set(k, []).get(k)).push(c);
    }
    for (const members of groups.values()) {
      let tried = 0;
      const leads = new Set();
      let opened = false;
      for (const [i, c] of members.entries()) {
        const r = row(kind, c, { why: c.why });
        const g = gate(kind, c);
        if (g) {
          unfired(r, g);
          continue;
        }
        const heuristic = c.why !== "listener";
        if ((heuristic && i > 0 && !opened) || (members.length > STATE_BOUND && ((tried >= sample && leads.size <= 1) || tried >= STATE_BOUND))) {
          unfired(r, "sampled-out");
          continue;
        }
        tried++;
        const res = await fire(kind, c, { element: { role: c.role, name: c.name, css: c.css, nth: c.nth } });
        if (res.children?.length) opened = true;
        leads.add((res.children ?? []).join(",") || res.outcome);
        push(r, res);
      }
    }
  }

  // drags, from the pre-state, reloaded after any change (a moved handle does not restore itself)
  for (const c of t.drag) {
    const vertical = c.orientation === "horizontal" ? c.role === "separator" : c.orientation === "vertical" && c.role !== "separator";
    const dx = vertical ? 0 : c.role === "slider" ? DRAG_BY / 2 : DRAG_BY;
    const dy = vertical ? (c.role === "slider" ? -DRAG_BY / 2 : DRAG_BY) : 0;
    const r = row("drag", c, { why: c.why, dx, dy });
    const g = gate("drag", c);
    if (g) {
      unfired(r, g);
      continue;
    }
    const res = await fire("drag", c, {
      element: { role: c.role, name: c.name, css: c.css, nth: c.nth, dx, dy },
      change: { read: () => page.evaluate(geometry, c.css), label: `drag: ${c.name}` },
      stateKey: `drag:${c.role}:${c.name}`,
    });
    push(r, res);
    if (res.outcome !== "inert" && !res.unfired) await reset();
  }

  // keys: documented shortcuts (or a probe set when the page listens globally), once per template
  const list = shortcuts ?? (t.globalKeys ? PROBE_KEYS.map((keys) => ({ keys, probe: true })) : []);
  for (const s of list) {
    const c = { role: "shortcut", name: s.keys, css: "" };
    const r = row("key", c, { key: s.keys, declared: s.probe ? undefined : { implemented: s.implemented, action: s.action, reason: s.reason ?? undefined } });
    const g = gate("key", c, s.keys);
    if (g) {
      unfired(r, g);
      continue;
    }
    push(r, await fire("key", c, { element: { role: "shortcut", name: s.keys, key: s.keys }, stateKey: `key:${s.keys}` }));
  }
  // keyboard activation: every control with a click edge, once per template, by Enter (Space for toggles)
  for (const o of outcomes) {
    if (o.href || !o.children?.length || o.unfired || !ACTIVATE_ROLES.has(o.role)) continue;
    const key = SPACE_ROLES.has(o.role) ? "Space" : "Enter";
    const c = { role: o.role, name: o.name, css: o.css };
    const r = row("key", c, { key, activates: o.children });
    const g = gate("key", c, key);
    if (g) {
      unfired(r, g);
      continue;
    }
    const focusable = await page.locator(`css=${o.css}`).first().evaluate((el) => el.tabIndex >= 0 && !el.disabled).catch(() => null);
    if (focusable === false) {
      unfired(r, "not-focusable");
      continue;
    }
    const res = await fire("key", c, { element: { role: o.role, name: o.name, css: o.css, key }, stateKey: `key:${key}:${o.role}:${o.name}` });
    push(r, { ...res, sameAsClick: (res.children ?? []).some((id) => o.children.includes(id)) });
  }

  // forms: (a) submit empty, (b) valid values then submit, (c) one invalid value per constraint
  for (const f of t.forms) {
    const fc = { role: f.role, name: f.name, css: f.css };
    // A validation state is named by what it shows (invalid fields, messages, submit disabled):
    // the same message reached two ways is one node, and pairs with the clone's by that name.
    const state = {
      read: () => page.evaluate(formState, f.css).then((x) => x?.digest ?? null),
      key: (d) => `form:${f.name}:${createHash("sha1").update(String(d)).digest("hex").slice(0, 10)}`,
      label: `form: ${f.name}`,
    };
    const sub = f.submit;
    const safe = sub ? classify(sub) : null;
    const subOk = sub && !(safe.verdict === "never" || (safe.verdict === "risky" && risky !== "probe"));
    const fills = (pick) => f.fields.map((x) => ({ css: x.css, role: x.role, name: x.name, ...pick(x) }));
    const valid = fills((x) => syntheticValue(x));
    const go = async (kind, c, extra, element) => {
      const r = row(kind, c, extra);
      const g = gate(kind, c, extra.case);
      if (g) return unfired(r, g);
      const res = await fire(kind, c, { element: { ...element, case: extra.case }, change: state, stateKey: `${kind}:${extra.case}:${f.name}` });
      push(r, { ...res, form: f.name });
      await reset();
    };
    if (f.search) {
      const field = f.fields.find((x) => x.type !== "checkbox" && !x.options) ?? f.fields[0];
      await go("input", fc, { case: "search" }, { ...fc, fills: [{ css: field.css, role: field.role, name: field.name, how: "fill", value: "a" }], enter: true });
      continue;
    }
    const subRow = sub ? { role: sub.role, name: sub.name, css: sub.css } : null;
    const submitOr = async (extra, theFills) => {
      if (!sub) return unfired(row("submit", fc, extra), "no-submit");
      if (!subOk) {
        pending(n, sub, safe.why, [], "risky-name");
        return unfired(row("submit", subRow, extra), `skipped:${safe.verdict}`);
      }
      if (sub.disabled && extra.case === "empty") return unfired(row("submit", subRow, extra), "submit-disabled");
      return go("submit", subRow, extra, { ...subRow, fills: theFills });
    };
    await submitOr({ case: "empty" }, fills((x) => (x.type === "checkbox" || x.type === "radio" ? { how: "uncheck", value: false } : x.options ? { how: "select", value: x.options[0]?.value ?? "" } : { how: "fill", value: "" })));
    await go("input", fc, { case: "valid" }, { ...fc, fills: valid });
    await submitOr({ case: "valid" }, valid);
    let cases = 0;
    for (const [i, x] of f.fields.entries()) {
      for (const bad of invalidValues(x)) {
        const extra = { case: `invalid:${x.name}:${bad.constraint}` };
        if (++cases > FORM_CASES) {
          unfired(row(sub ? "submit" : "input", sub ? subRow : fc, extra), "sampled-out");
          continue;
        }
        const theFills = valid.map((v, j) => (j === i ? { ...v, how: bad.how, value: bad.value } : v));
        if (sub && subOk && !sub.disabled) await go("submit", subRow, extra, { ...subRow, fills: theFills });
        else await go("input", fc, extra, { ...fc, fills: theFills });
      }
    }
  }

  // file inputs: accept list and size limit always; uploads only where writes are allowed
  for (const fi of t.files) {
    const meta = { accept: fi.accept, maxSize: fi.maxSize, multiple: fi.multiple };
    for (const kase of fi.accept.length ? ["accepted", "rejected"] : ["accepted"]) {
      const r = row("upload", fi, { case: kase, ...meta });
      const g = gate("upload", fi, kase);
      if (g) {
        unfired(r, g);
        continue;
      }
      if (!writesAllowed) {
        unfired(r, "upload-needs-writes");
        continue;
      }
      push(r, await fire("upload", fi, { element: { role: fi.role, name: fi.name, css: fi.css, accept: fi.accept, case: kase }, change: { read: () => page.evaluate(textAround, fi.css), label: `upload: ${fi.name}` }, stateKey: `upload:${kase}:${fi.name}` }));
      await reset();
    }
  }
  return { rows, keys, forms: t.forms.map((f) => ({ name: f.name, search: f.search, fields: f.fields.map((x) => ({ name: x.name, type: x.type, required: x.required, pattern: x.pattern, min: x.min, max: x.max, minLength: x.minLength })), submit: f.submit?.name ?? null })), files: t.files, globalKeys: t.globalKeys };
}

/**
 * Every interaction row must be accounted for: an edge with its child, a fired result (no
 * change, a write attempt, a native dialog or download), or a known unfired reason. Returns the
 * violations; empty is closed. `known` is the walker's set of unfired reasons.
 */
export function interactionInvariant(rows, known) {
  const bad = [];
  for (const r of rows) {
    const who = `${r.kind} ${r.role} "${String(r.name ?? "").slice(0, 40)}"${r.case ? ` [${r.case}]` : ""}`;
    if (!INTERACTION_KINDS.includes(r.kind)) bad.push(`${who}: unknown kind`);
    else if (r.unfired !== undefined) {
      if (!known(r.unfired) && !INTERACTION_UNFIRED.has(r.unfired)) bad.push(`${who}: unfired without a known reason (${r.unfired})`);
    } else if (["inert", "write-attempt"].includes(r.outcome) || /^(native-dialog|download): /.test(r.outcome ?? "")) {
      // fired, recorded
    } else if (!r.to?.length) bad.push(`${who}: outcome ${r.outcome ?? "none"} without an edge`);
  }
  return bad;
}
