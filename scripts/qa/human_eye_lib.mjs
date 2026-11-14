// What human_eye.mjs looks for, as functions other tools can call on a page they already hold
// (orchestrator/verify.mjs runs them on a clone node reached by its replay route, scoped to an
// overlay when the node is one). No top-level effects: importing this runs nothing.
//
//   inspect        in-page (page.evaluate): stand-in and broken images, clipped text, dead links,
//                  sideways page overflow (page scope only)
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
  return findings;
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
