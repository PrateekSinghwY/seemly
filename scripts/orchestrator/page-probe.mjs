// What the explorer reads from a live page. Every export here is serialised into the page by
// `page.evaluate`, so each function must be self-contained: no imports, no closures over this
// module, helpers declared inside.
//
// One reading gives three things the graph needs:
//   signature   the DOM skeleton (tag[role] paths, text and attributes stripped), each path's
//               count bucketed by log2 so a list of 10 rows and one of 50 still look alike, and
//               each path hashed so graph.json stays small
//   modules     the same skeleton per landmark and per child of <main>, for module archetypes
//   candidates  every element that could open, change or navigate something
//
// Overlays (dialogs, menus, popovers) are found by marking what floats before an interaction
// and looking for floating things that are new after it.

/** Probe the page, or one overlay of it when `scopeCss` names the overlay's root. */
export function probe({ scopeCss = null, sigOnly = false, maxDepth = 18, maxModules = 40 } = {}) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "BR", "WBR"]);
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const sigOf = (root) => {
    const counts = new Map();
    const walk = (el, path, depth) => {
      for (const c of el.children) {
        if (SKIP.has(c.tagName) || !visible(c)) continue;
        const role = c.getAttribute("role");
        const p = `${path}/${c.tagName.toLowerCase()}${role ? `[${role}]` : ""}`;
        counts.set(p, (counts.get(p) ?? 0) + 1);
        if (depth < maxDepth && c.tagName.toLowerCase() !== "svg") walk(c, p, depth + 1);
      }
    };
    walk(root, "", 0);
    const out = [];
    for (const [p, n] of counts) for (let i = 0; i <= Math.floor(Math.log2(n)); i++) out.push(fnv(p));
    return out.sort();
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
  const text = (s, n = 80) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const nameOf = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    const byId = lb ? lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ") : "";
    return text(
      el.getAttribute("aria-label") || byId || el.innerText || el.getAttribute("title") || el.querySelector("img[alt]")?.alt ||
        el.querySelector("svg title")?.textContent || el.value || el.getAttribute("placeholder") || "",
    );
  };
  const IMPLICIT = { A: "link", BUTTON: "button", SUMMARY: "button", SELECT: "combobox", TEXTAREA: "textbox" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.split(/\s+/)[0];
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", range: "slider" }[t] ?? "textbox";
    }
    return IMPLICIT[el.tagName] ?? "generic";
  };

  const root = (scopeCss && document.querySelector(scopeCss)) || document.body;
  if (sigOnly) return { url: location.href, signature: sigOf(root) };
  const SEL = [
    "a[href]", "button", "summary", "select", "textarea", "input:not([type=hidden])", "[onclick]", "[tabindex='0']",
    "[aria-haspopup]", "[aria-expanded]",
    ...["button", "link", "tab", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "switch", "checkbox", "radio", "combobox", "treeitem", "gridcell", "row"].map((r) => `[role=${r}]`),
  ].join(",");
  const marked = new Set(root.querySelectorAll(SEL));
  // Card-like elements: a pointer cursor that does not come from a parent that is itself one.
  for (const el of root.querySelectorAll("div,li,span,tr,td,img,svg,article,section,label,p,h1,h2,h3,h4,h5,h6")) {
    if (marked.has(el) || !visible(el)) continue;
    if (getComputedStyle(el).cursor !== "pointer") continue;
    const parent = el.parentElement;
    if (parent && getComputedStyle(parent).cursor === "pointer") continue;
    if (el.closest(SEL)) continue;
    marked.add(el);
  }
  const seen = new Map();
  const candidates = [];
  for (const el of marked) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const role = roleOf(el);
    const name = nameOf(el);
    const key = `${role}|${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const type = (el.getAttribute("type") || "").toLowerCase();
    candidates.push({
      role,
      name,
      nth,
      tag: el.tagName.toLowerCase(),
      css: cssPath(el),
      href: el.tagName === "A" ? el.href : null,
      target: el.getAttribute("target"),
      haspopup: el.getAttribute("aria-haspopup"),
      expanded: el.getAttribute("aria-expanded"),
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      field: (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image"].includes(type)) || el.tagName === "TEXTAREA",
      options: el.tagName === "SELECT" ? [...el.options].map((o) => text(o.textContent, 60)) : null,
      inNav: !!el.closest("nav,header,[role=navigation],[role=banner],[role=menubar]"),
      cardLike: !el.matches(SEL),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }

  // Modules: landmarks not nested in another landmark, plus each visible child of <main>.
  const LANDMARK = "header,nav,footer,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary]";
  const moduleRoots = [...root.querySelectorAll(LANDMARK)].filter((el) => visible(el) && !el.parentElement?.closest(LANDMARK));
  const main = root.querySelector("main,[role=main]");
  if (main) moduleRoots.push(...[...main.children].filter((el) => visible(el) && !SKIP.has(el.tagName)));
  const modules = moduleRoots.slice(0, maxModules).map((el) => [fnv(`root:${el.tagName.toLowerCase()}`), ...sigOf(el)]);

  const heading = text(root.querySelector("h1,h2,[role=heading]")?.innerText, 60);
  return {
    url: location.href,
    title: document.title,
    heading,
    signature: sigOf(root),
    modules,
    candidates,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
}

const FLOATING_SEL = [
  "[role=dialog]", "[role=alertdialog]", "dialog[open]", "[aria-modal=true]", "[role=menu]", "[role=listbox]", "[role=tooltip]",
  "[role=tree]", "[data-radix-popper-content-wrapper]", "[data-floating-ui-portal] > *",
].join(",");

/** Mark everything that floats right now, so `newOverlays` can tell what an interaction opened. */
export function markFloating(sel) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  let n = 0;
  for (const el of document.querySelectorAll(sel)) if (visible(el)) (el.dataset.seemlyPre = "1"), n++;
  for (const el of document.body.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if ((cs.position === "fixed" || cs.position === "absolute") && visible(el)) (el.dataset.seemlyPre = "1"), n++;
  }
  return n;
}

/**
 * Floating things that were not there when `markFloating` ran: role-marked overlays first,
 * then any large new fixed/absolute box with a z-index. Outermost only. Each comes back with
 * a css path the explorer can scope the next probe to.
 */
export function newOverlays(sel) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
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
  const found = [];
  for (const el of document.querySelectorAll(sel)) if (visible(el) && !el.dataset.seemlyPre) found.push(el);
  for (const el of document.body.querySelectorAll("*")) {
    if (el.dataset.seemlyPre || !visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 4000 || cs.zIndex === "auto" || +cs.zIndex < 1) continue;
    found.push(el);
  }
  const outer = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
  return outer.map((el) => {
    const role = el.getAttribute("role") || (el.tagName === "DIALOG" ? "dialog" : el.getAttribute("aria-modal") === "true" ? "dialog" : "overlay");
    const r = el.getBoundingClientRect();
    return {
      role,
      name: text(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3,[role=heading]")?.innerText || [...el.children].map((c) => text(c.innerText, 20)).filter(Boolean).join(" · ")),
      css: cssPath(el),
      area: Math.round(r.width * r.height),
    };
  }).sort((a, b) => b.area - a.area);
}

/**
 * Overlays already open when a page loads: a product tour, a consent prompt, a what's-new
 * modal. Each is its own surface, and the page behind it is a different one: a census taken
 * with it open counted a handful of controls where the page had about two hundred.
 */
export function openOnLoad() {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const text = (s, n = 60) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const SEL = [
    "[role=dialog]", "[role=alertdialog]", "dialog[open]", "[aria-modal=true]",
    ".introjs-tooltip", ".shepherd-element", ".driver-popover", "#pendo-guide-container", "[class*=appcues]",
    "#onetrust-banner-sdk", "[id*=cookie-banner]", "[class*=cookie-banner]", "[class*=CookieBanner]",
  ].join(",");
  const found = [...document.querySelectorAll(SEL)].filter(visible);
  const outer = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
  return outer.map((el, i) => {
    el.dataset.seemlyOnload = String(i);
    return {
      role: el.getAttribute("role") || "dialog",
      name: text(el.getAttribute("aria-label") || el.querySelector("h1,h2,h3,[role=heading]")?.innerText || el.innerText),
      css: `[data-seemly-onload="${i}"]`,
    };
  });
}

/**
 * What floats right now, as a census the explorer compares against a node's pre-state: every
 * visible role-marked overlay (tooltips aside: they follow the pointer) and every large z-indexed
 * fixed/absolute box, outermost only. `key` is role plus css path, so an extra open menu shows as
 * an extra key; `close` names a dismiss control inside it, if it has one.
 */
export function openFloating(sel) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
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
  const found = [];
  for (const el of document.querySelectorAll(sel)) if (visible(el) && el.getAttribute("role") !== "tooltip") found.push(el);
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 40000 || cs.zIndex === "auto" || +cs.zIndex < 1) continue;
    found.push(el);
  }
  const outer = [...new Set(found)].filter((el) => !found.some((o) => o !== el && o.contains(el)));
  const DISMISS = /^(close|dismiss|done|cancel|skip( tour)?|got it|no,? thanks|not now|maybe later|later|ok(ay)?|back|×|✕|x)$|^close\b/i;
  return outer
    .map((el) => {
      const role = el.getAttribute("role") || (el.tagName === "DIALOG" ? "dialog" : "overlay");
      const css = cssPath(el);
      const btn = [...el.querySelectorAll("button,[role=button],a")].find((b) => visible(b) && DISMISS.test((b.getAttribute("aria-label") || b.innerText || b.getAttribute("title") || "").trim()));
      return { key: `${role}@${css}`, role, css, close: btn ? (btn.id ? `#${CSS.escape(btn.id)}` : cssPath(btn)) : null };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * Is this page a sign-in page, a session-ended notice, or a transient error page (a 5xx, a
 * "service unavailable")? `loginSrc` is a regex source for sign-in URLs; the default covers the
 * usual paths and identity hosts. Read on every navigation the explorer makes.
 */
export function sessionState({ loginSrc = null } = {}) {
  const visible = (el) => (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);
  const href = location.href;
  const login = new RegExp(
    loginSrc ||
      "(^https?://(login|auth|sso|idp|signin|accounts)[.-])|/(login|log-in|signin|sign-in|sign_in|logon|authn?|sso|saml2?|oauth2?|openid|adfs|cas|idp)(/|\\?|#|\\.|$)",
    "i",
  );
  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
  const short = text.length < 1500;
  const transient =
    /serviceUnavailable|service[-_]unavailable/i.test(href) ||
    /^(5\d\d\b|service unavailable|bad gateway|gateway time-?out|temporarily unavailable)/i.test(document.title) ||
    (short && /\b(503 service unavailable|502 bad gateway|504 gateway time-?out|service (is )?(temporarily )?unavailable|temporarily unavailable|try again (in a few|later))\b/i.test(text));
  const pw = [...document.querySelectorAll("input[type=password]")].some(visible);
  const signInBtn = [...document.querySelectorAll("button,input[type=submit],[role=button]")].some((b) => visible(b) && /^(sign ?in|log ?in|continue|next)$/i.test((b.innerText || b.value || "").trim()));
  const ended = /\b(session (has )?(expired|ended|timed out)|you have been (logged|signed) out|please (log|sign) in again)\b/i.test(text.slice(0, 4000));
  const isLogin = login.test(href) || (pw && signInBtn && text.length < 3000);
  return { href, transient, login: isLogin, ended, why: transient ? "transient error page" : isLogin ? "sign-in page" : ended ? "session-ended notice" : null };
}

/** Drop the marks so the next interaction starts clean. */
export function clearMarks() {
  for (const el of document.querySelectorAll("[data-seemly-pre]")) delete el.dataset.seemlyPre;
}

export { FLOATING_SEL };
