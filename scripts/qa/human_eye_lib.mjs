// What human_eye.mjs looks for, as functions other tools can call on a page they already hold
// (orchestrator/verify.mjs runs them on a clone node reached by its replay route, scoped to an
// overlay when the node is one). No top-level effects: importing this runs nothing.
//
//   inspect        in-page (page.evaluate): stand-in and broken images, clipped text, dead links,
//                  sideways page overflow (page scope only), text painted over other text
//                  (text-overlap), text controls with no gap that read as one word
//                  (controls-touching), text painting past the edge of a box too small for it
//                  (text-spill). Icon-font glyph names are not text to these three; boxes are
//                  measured on the part a person sees (scroll containers, sticky strips).
//   unnamed        a button, link or field with no accessible name, from the AX tree
//   deadControls   an enabled control that does nothing when clicked: no DOM change, no
//                  navigation, no request in a second. The caller aborts writes in the context.

import { settle } from "../lib/pw.mjs";

/** The controls a person expects to do something when clicked. */
export const CONTROL_SEL = "button:not([disabled]),[role=button]:not([aria-disabled=true]),[role=tab],[role=menuitem],a[href]";

/** In-page, self-contained. `scopeCss` limits every reading to that element (an overlay). */
export function inspect({ scopeCss = null } = {}) {
  const root = (scopeCss && document.querySelector(scopeCss)) || document.body;
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const where = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(e.tagName.toLowerCase() + (e.classList[0] ? `.${e.classList[0]}` : ""));
    return parts.join(" > ");
  };
  const findings = [];
  const LAYER_ROLES = new Set(["dialog", "alertdialog", "menu", "listbox", "tooltip"]);
  const places = new Map();
  let stickies = null;

  // Stand-in images: one src, several different things it stands for.
  const bySrc = new Map();
  for (const img of root.querySelectorAll("img")) {
    if (!visible(img)) continue;
    if (img.complete && img.naturalWidth === 0) {
      findings.push({ kind: "broken-image", where: where(img), detail: img.currentSrc || img.src });
      continue;
    }
    const src = img.currentSrc || img.src;
    if (!src || img.alt === "" && img.getAttribute("role") === "presentation") continue;
    const card = img.closest("article,li,tr,[class*=card],[class*=Card],[class*=item],[class*=Item]");
    const label = text(img.alt) || text(card?.querySelector("h1,h2,h3,h4,h5,h6,strong,a")?.innerText) || "";
    if (!label) continue;
    (bySrc.get(src) ?? bySrc.set(src, new Set()).get(src)).add(label);
  }
  for (const [src, labels] of bySrc) if (labels.size >= 2) findings.push({ kind: "stand-in-image", where: src, detail: `one image for ${labels.size} different things: ${[...labels].slice(0, 4).join(" / ")}` });

  // Clipped text.
  for (const el of root.querySelectorAll("*")) {
    if (!visible(el) || !el.childNodes.length) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    // Visually hidden on purpose (screen-reader-only text): a 1px clipped box is not clipped text.
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1 || (cs.clip && cs.clip !== "auto") || /inset\(50%\)/.test(cs.clipPath)) continue;
    const hidesX = /hidden|clip/.test(cs.overflowX);
    const hidesY = /hidden|clip/.test(cs.overflowY);
    if (hidesX && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis") findings.push({ kind: "clipped", where: where(el), detail: `sideways, "${text(el.innerText, 40)}"` });
    else if (hidesY && el.scrollHeight > el.clientHeight + 2 && cs.webkitLineClamp === "none") findings.push({ kind: "clipped", where: where(el), detail: `cut at the bottom, "${text(el.innerText, 40)}"` });
  }

  if (root === document.body && document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) findings.push({ kind: "page-overflow", where: "html", detail: `${document.documentElement.scrollWidth}px wide in a ${document.documentElement.clientWidth}px viewport` });
  for (const a of root.querySelectorAll('a[href="#"],a[href=""],a[href^="javascript:void"]')) if (visible(a) && !a.getAttribute("role")) findings.push({ kind: "dead-link", where: where(a), detail: text(a.innerText) || "(no text)" });

  findings.push(...textOverlap(), ...controlsTouching(), ...textSpill());
  return findings;

  // Shared by the three layout checks below.
  //
  // Icon-font glyphs: a Material Symbols/Icons ligature is a word in the DOM ("expand_more") and
  // one glyph on screen, so its text box is fiction (wide when the font is late or missing).
  function glyph(el) {
    return !!el && (!!el.closest("[class*=material-symbols],[class*=material-icons]") || /material (symbols|icons)/i.test(getComputedStyle(el).fontFamily));
  }
  // Where an element sits: the part no overflow ancestor clips (`clip`), its stacking layer (an
  // absolute/fixed/sticky box, or a dialog, menu, listbox or tooltip, meant to sit over other
  // content, so only compared within itself), and its nearest non-inline box (`block`).
  function placeOf(el) {
    if (!el) return { clip: { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity }, layer: null, block: null };
    if (places.has(el)) return places.get(el);
    let clip = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    let layer = null;
    let block = null;
    let fixed = false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (!block && !/^inline$|^contents$/.test(cs.display)) block = e;
      if (!layer && (LAYER_ROLES.has(e.getAttribute("role")) || /absolute|fixed|sticky/.test(cs.position))) layer = e;
      if (!fixed && cs.display !== "contents" && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
        const r = e.getBoundingClientRect();
        const l = r.left + e.clientLeft;
        const t = r.top + e.clientTop;
        clip = { l: Math.max(clip.l, l), t: Math.max(clip.t, t), r: Math.min(clip.r, l + e.clientWidth), b: Math.min(clip.b, t + e.clientHeight) };
      }
      if (cs.position === "fixed") fixed = true; // a fixed box escapes every overflow above it
    }
    const v = { clip, layer, block };
    places.set(el, v);
    return v;
  }
  // The part of a box a person can see: inside every scroll container around it, and not under a
  // sticky strip (a stuck header, tab strip or footer spanning it) that does not hold it.
  // Seen 2026-11-16: rows scrolled under a sticky tab strip still reported their full boxes.
  function seenBox(el, r, place = placeOf(el)) {
    const { clip } = place;
    const box = { l: Math.max(r.left, clip.l), t: Math.max(r.top, clip.t), r: Math.min(r.right, clip.r), b: Math.min(r.bottom, clip.b) };
    stickies ??= [...document.querySelectorAll("*")].filter((s) => getComputedStyle(s).position === "sticky" && visible(s)).map((s) => ({ s, r: s.getBoundingClientRect() }));
    for (const { s, r: o } of stickies) {
      if (s.contains(el) || el.contains(s) || o.left > box.l + 1 || o.right < box.r - 1 || o.bottom <= box.t || o.top >= box.b) continue;
      if ((o.top + o.bottom) / 2 <= (box.t + box.b) / 2) box.t = Math.max(box.t, o.bottom);
      else box.b = Math.min(box.b, o.top);
    }
    return box;
  }

  // Text painted over text: leaf text-node line boxes (Range.getClientRects) from two different
  // blocks in one layer intersecting by more than 2px both ways, measured on the part a person
  // sees (seenBox). Seen 2026-11-16: flex rows with min-height 0 shrank below their wrapped
  // text in a scroller.
  function textOverlap() {
    const TOL = 2;
    const lines = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TEXTAREA)$/.test(el.tagName) || !visible(el) || glyph(el)) continue;
      if (/rgba\(.*,\s*0\)$|transparent/.test(getComputedStyle(el).color)) continue;
      const place = placeOf(el);
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const box = seenBox(el, r, place);
        if (box.r - box.l > TOL && box.b - box.t > TOL) lines.push({ ...box, node: n, el, layer: place.layer, block: place.block });
      }
    }
    lines.sort((a, b) => a.t - b.t);
    const out = [];
    const seen = new Set();
    for (let i = 0; i < lines.length && out.length < 20; i++) {
      const a = lines[i];
      for (let j = i + 1; j < lines.length && lines[j].t < a.b - TOL; j++) {
        const b = lines[j];
        if (a.node === b.node || a.block === b.block || a.layer !== b.layer) continue;
        if (Math.min(a.r, b.r) - Math.max(a.l, b.l) <= TOL || Math.min(a.b, b.b) - Math.max(a.t, b.t) <= TOL) continue;
        const key = `${where(a.el)}|${where(b.el)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: "text-overlap", where: where(a.el), detail: `"${text(a.node.textContent, 30)}" painted over "${text(b.node.textContent, 30)}" [${where(b.el)}]` });
        break;
      }
    }
    return out;
  }

  // Two text controls in one layer, on one row, with under 4px between their seen boxes and
  // under a space's width (0.25em) between their text read as one word ("BackSubmit"). Icon-only
  // controls (glyph text is not text), text fields and a role=group/toolbar whose items are
  // divided by a visible border or separator are skipped. A drawer, slider or menu laid over
  // page controls is another layer and never compared with them.
  // Seen 2026-11-16: a justify-end footer around a justify-between child collapsed to 0px.
  function controlsTouching() {
    const SEL = "button,a[href],[role=button],input,select";
    const textNodes = (el) => {
      const out = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() && n.parentElement && visible(n.parentElement) && !glyph(n.parentElement)) out.push(n);
      return out;
    };
    const label = (el, nodes) => {
      if (el.tagName === "INPUT") return /^(button|submit|reset)$/.test(el.type) ? el.value : "";
      if (el.tagName === "SELECT") return el.selectedOptions?.[0]?.text ?? "";
      return nodes.map((n) => n.textContent).join(" ");
    };
    const textBox = (el, r, nodes) => {
      if (nodes.length) {
        const range = document.createRange();
        let left = Infinity;
        let right = -Infinity;
        for (const n of nodes) {
          range.selectNodeContents(n);
          const t = range.getBoundingClientRect();
          if (t.width > 0) {
            left = Math.min(left, t.left);
            right = Math.max(right, t.right);
          }
        }
        if (right > left) return { left, right };
      }
      const cs = getComputedStyle(el);
      const px = (p) => parseFloat(cs[p]) || 0;
      return { left: r.left + px("borderLeftWidth") + px("paddingLeft"), right: r.right - px("borderRightWidth") - px("paddingRight") };
    };
    const ctrls = [];
    for (const el of root.querySelectorAll(SEL)) {
      if (!visible(el) || (el.tagName === "INPUT" && el.type === "hidden")) continue;
      if (el.parentElement?.closest(SEL)) continue; // nested inside another control
      const nodes = /^(INPUT|SELECT)$/.test(el.tagName) ? [] : textNodes(el);
      const name = text(label(el, nodes), 40);
      if (!name) continue; // icon-only or a text field
      const raw = el.getBoundingClientRect();
      // Layer and clip of the place the control sits in (its parent), so a control that is
      // itself absolute still compares with its absolute siblings.
      const place = placeOf(el.parentElement);
      const s = seenBox(el, raw, place);
      if (s.r - s.l < 2 || s.b - s.t < 2) continue; // scrolled out of view or under a sticky strip
      const r = { left: s.l, top: s.t, right: s.r, bottom: s.b, height: s.b - s.t };
      ctrls.push({ el, r, name, layer: place.layer, tb: textBox(el, raw, nodes), em: parseFloat(getComputedStyle(el).fontSize) || 16 });
    }
    const border = (cs, side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none" && !/rgba\(.*,\s*0\)$|transparent/.test(cs[`border${side}Color`]);
    const divided = (a, b) => {
      const group = a.el.closest("[role=group],[role=toolbar]");
      if (!group || !group.contains(b.el)) return false;
      if (border(getComputedStyle(a.el), "Right") || border(getComputedStyle(b.el), "Left")) return true;
      return [...group.querySelectorAll("[role=separator],hr")].some((s) => {
        const r = s.getBoundingClientRect();
        return visible(s) && r.left >= a.r.right - 1 && r.right <= b.r.left + 1;
      });
    };
    const out = [];
    for (const a of ctrls) {
      let best = null;
      for (const b of ctrls) {
        if (b === a || b.layer !== a.layer || b.r.left <= a.r.left || b.r.right <= a.r.right) continue;
        const vo = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (vo <= 0.5 * Math.min(a.r.height, b.r.height)) continue;
        const gap = b.r.left - a.r.right;
        if (!best || gap < best.gap) best = { b, gap };
      }
      if (!best || best.gap >= 4) continue;
      const b = best.b;
      if (b.tb.left - a.tb.right >= 0.25 * Math.min(a.em, b.em) || divided(a, b)) continue;
      out.push({ kind: "controls-touching", where: where(a.el), detail: `"${a.name}" and "${b.name}" ${Math.round(best.gap)}px apart, read as "${a.name}${b.name}"` });
    }
    return out;
  }

  // Text whose line boxes paint past the edge of a box that holds it with overflow visible: the
  // box has a height or width (fixed, max, or a flex shrink) smaller than its text, so a label
  // wraps to three lines in a 36px field or a value runs out of its cell. The walk up stops at a
  // box that clips (the clipped check owns that) and at a layer edge. Line-clamped, ellipsis,
  // screen-reader-only and glyph text are skipped, as are boxes as tall or wide as the viewport
  // (a 100%-height shell the document scrolls past) and collapsed wrappers under 2px.
  // Seen 2026-11-16: labels wrapping out of fixed-height fields in the UKG clone.
  function textSpill() {
    const range = document.createRange();
    const out = [];
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
    for (let n = walker.nextNode(); n && out.length < 20; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TEXTAREA)$/.test(el.tagName) || !visible(el) || glyph(el)) continue;
      const s = n.textContent;
      const start = s.search(/\S/);
      const end = s.length - (s.length - s.trimEnd().length);
      range.setStart(n, start);
      range.setEnd(n, end);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      const tol = Math.max(2, 0.2 * (parseFloat(getComputedStyle(el).fontSize) || 16));
      for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.webkitLineClamp !== "none" || cs.textOverflow === "ellipsis") break;
        if ((cs.clip && cs.clip !== "auto") || /inset\(50%\)/.test(cs.clipPath)) break; // screen-reader-only
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") break;
        if (!/^inline$|^contents$/.test(cs.display)) {
          const b = e.getBoundingClientRect();
          if (b.width <= 1 || b.height <= 1) break; // sr-only 1px box, or a collapsed wrapper below
          let dy = 0;
          let dx = 0;
          if (b.height < innerHeight - 1) for (const r of rects) dy = Math.max(dy, r.bottom - b.bottom, b.top - r.top);
          if (b.width < innerWidth - 1) for (const r of rects) dx = Math.max(dx, r.right - b.right, b.left - r.left);
          if (dy > tol || dx > tol) {
            const key = where(e);
            if (!seen.has(key)) {
              seen.add(key);
              const how = dy > tol ? `${Math.round(dy)}px past a ${Math.round(b.height)}px-high box` : `${Math.round(dx)}px past a ${Math.round(b.width)}px-wide box`;
              out.push({ kind: "text-spill", where: key, detail: `"${text(s, 40)}" paints ${how}` });
            }
            break;
          }
        }
        if (LAYER_ROLES.has(e.getAttribute("role")) || /absolute|fixed|sticky/.test(cs.position)) break;
      }
    }
    return out;
  }
}

const NAMED = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "switch", "tab", "menuitem", "slider", "spinbutton", "searchbox", "listbox", "option"]);

/** Controls with no accessible name, from the full AX tree; only those inside `scopeCss` when given. */
export async function unnamed(page, { scopeCss = null } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const out = [];
    for (const n of nodes) {
      if (n.ignored || !NAMED.has(n.role?.value) || (n.name?.value ?? "").trim()) continue;
      if (scopeCss && n.backendDOMNodeId) {
        const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId }).catch(() => ({}));
        if (!object?.objectId) continue;
        const { result } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: `function (s) { const r = document.querySelector(s); return !!r && r.contains(this); }`, arguments: [{ value: scopeCss }], returnByValue: true });
        if (!result?.value) continue;
      }
      out.push({ kind: "unnamed-control", where: `${n.role.value} (backend node ${n.backendDOMNodeId})`, detail: "no accessible name" });
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Click each enabled control (inside `scopeCss`, when given) from a fresh state and watch for
 * any effect for one second. `reset(page)` puts the page back in that state before every click
 * (a reload, or a replay route for an overlay) and returns the scope css it lands on. Writes
 * must already be aborted in the page's context: the sweep clicks Save buttons.
 */
export async function deadControls(page, { reset, scopeCss = null } = {}) {
  const mark = ({ sel, scopeCss }) => {
    const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
    const root = (scopeCss && document.querySelector(scopeCss)) || document.body;
    return [...root.querySelectorAll(sel)].filter(visible).map((el, i) => {
      el.dataset.seemlyDead = String(i);
      return { i, name: (el.getAttribute("aria-label") || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50) };
    });
  };
  const list = await page.evaluate(mark, { sel: CONTROL_SEL, scopeCss });
  const found = [];
  for (const c of list) {
    const scope = (await reset(page)) ?? scopeCss;
    await page.evaluate(mark, { sel: CONTROL_SEL, scopeCss: scope });
    let requests = 0;
    const onReq = () => requests++;
    page.on("request", onReq);
    await page.evaluate(() => {
      window.__seemlyMut = 0;
      new MutationObserver((m) => (window.__seemlyMut += m.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const before = page.url();
    const target = page.locator(`[data-seemly-dead="${c.i}"]`).first();
    // Not there after the reset (the state did not come back): not evidence either way.
    const present = (await target.count()) > 0;
    if (present) await target.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(1000);
    page.off("request", onReq);
    const mutations = await page.evaluate(() => window.__seemlyMut ?? 0).catch(() => 1);
    if (present && !mutations && !requests && page.url() === before) found.push({ kind: "dead-control", where: `#${c.i}`, detail: `"${c.name || "(no name)"}" does nothing` });
  }
  return found;
}

/** Reset for a page reached by URL: reload it and let it settle. */
export const reloadTo = (url) => async (page) => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page, 4000);
  return null;
};
