// The explore loop (orchestrator step 3): pop a node, reach it by its cheapest replay route,
// read it, fire every element once, record what each one opened, push the children, close the
// node, save. Repeats until the frontier is empty or the run's node budget is spent; a later
// run resumes from graph.json with nothing lost or repeated.
//
// Safety is in safety.mjs: names that end the session are never clicked, money/messaging/
// deletion names are queued for BLOCKED, and every non-read request is aborted in the browser.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openReference, settle } from "../lib/pw.mjs";
import { similarity } from "./algorithms.mjs";
import { STATE_BOUND, admit, inScope, repeatGroup } from "./bound.mjs";
import { canonicalUrl } from "./graph.mjs";
import { FLOATING_SEL, clearMarks, markFloating, newOverlays, openOnLoad, probe } from "./page-probe.mjs";
import { classify, isWrite } from "./safety.mjs";
import { save } from "./store.mjs";

/** Below this skeleton similarity, a click that kept the URL made a new state. */
export const SAME_STATE = 0.97;
/** At or above it, two readings on one URL are the same surface. */
export const SAME_SURFACE = 0.995;
/** Repeated siblings sampled from a group larger than STATE_BOUND before stopping. */
export const SAMPLE = 5;
/** Members of one template expanded in full before the rest fire only what is new to it. */
export const TEMPLATE_SAMPLE = 2;

export class SessionLost extends Error {}

/** The browser itself went away (a stop signal, a crash): not the node's fault, end the run. */
const BROWSER_GONE = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target crashed/i;
/** The machine lost its network: wait and retry the node, never count it against the node. */
const NETWORK_GONE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_RESET/;

const DISMISS = /^(close|dismiss|skip( tour)?|got it|no,? thanks|not now|maybe later|later|ok(ay)?|accept( all)?|×|✕|x)$/i;

/**
 * Close whatever opened on load, reading each overlay first. Escape, then the overlay's own
 * dismiss control. Returns what was open, with its skeleton, so the caller can record it.
 */
export async function dismissOnLoad(p) {
  const seen = [];
  for (let round = 0; round < 3; round++) {
    const [ov] = await p.evaluate(openOnLoad);
    if (!ov || seen.some((s) => s.name === ov.name)) break;
    ov.signature = (await p.evaluate(probe, { scopeCss: ov.css, sigOnly: true })).signature;
    seen.push(ov);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    if ((await p.locator(`css=${ov.css}`).count()) && (await p.locator(`css=${ov.css}`).isVisible().catch(() => false))) {
      const btn = p.locator(`css=${ov.css}`).getByRole("button", { name: DISMISS });
      if (await btn.count()) await btn.first().click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(300);
    }
  }
  return seen;
}

const KIND_OF_ROLE = { dialog: "modal", alertdialog: "modal", menu: "menu", listbox: "menu", tooltip: "tooltip", tree: "menu" };

export async function explore(g, dir, opts = {}) {
  const { maxNodes = Infinity, risky = "record", allowPost = [], sample = SAMPLE, onlyPrefix = null, log = (s) => console.error(s) } = opts;
  // A worker that owns part of the site: nodes outside its prefixes are set aside, untouched,
  // and put back on the frontier at the end for the worker that owns them.
  const mine = (n) => !onlyPrefix || inScope(n.href ?? n.url, { origin: g.data.meta.origin, prefix: onlyPrefix });
  const deferred = [];
  const scope = { origin: g.data.meta.origin, prefix: g.data.meta.prefix ?? "/" };
  g.data.meta.bounds ??= {};
  g.data.meta.links ??= {};
  g.data.meta.shellClicks ??= {};
  const pendingPath = join(dir, "pending-writes.jsonl");
  const pendingKeys = new Set(existsSync(pendingPath) ? readFileSync(pendingPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);

  const { context, close } = await openReference(opts);
  const net = { blocked: [], popups: [], dialogs: [], downloads: [], bodies: null, failures: [] };
  // Broken flows: an API answer >= 400 or an uncaught script error, tied to the node and the
  // click that caused it, in errors.jsonl. A walk that only records what opened misses a save
  // that 500s behind a toast.
  const errorsPath = join(dir, "errors.jsonl");
  let current = { node: null, element: null };
  const failure = (kind, detail) => {
    const row = { kind, detail, node: current.node, element: current.element };
    net.failures.push(row);
    appendFileSync(errorsPath, JSON.stringify(row) + "\n");
  };
  await context.route("**/*", (route) => {
    const req = route.request();
    if (isWrite({ method: req.method(), url: req.url(), postData: req.postData() }, allowPost)) {
      net.blocked.push({ method: req.method(), url: req.url(), body: (req.postData() ?? "").slice(0, 2000) });
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const side = await context.newPage();
  for (const p of [page, side]) {
    p.on("dialog", (d) => {
      net.dialogs.push(d.message());
      d.dismiss().catch(() => {});
    });
    p.on("download", (d) => {
      net.downloads.push(d.suggestedFilename());
      d.cancel().catch(() => {});
    });
  }
  // Only popups our own pages open: attached over CDP, other tabs in the window are not ours.
  const onPopup = async (p) => {
    await p.waitForLoadState("commit", { timeout: 5000 }).catch(() => {});
    net.popups.push(p.url());
    await p.close().catch(() => {});
  };
  page.on("popup", onPopup);
  side.on("popup", onPopup);
  page.on("pageerror", (e) => failure("script-error", e.message.split("\n")[0].slice(0, 300)));
  page.on("response", (res) => {
    const req = res.request();
    if (res.status() >= 400 && ["xhr", "fetch", "document"].includes(req.resourceType()) && inScope(res.url(), { origin: scope.origin, prefix: "/" }))
      failure(`http-${res.status()}`, `${req.method()} ${new URL(res.url()).pathname}`);
  });
  page.on("response", async (res) => {
    if (!net.bodies) return;
    const req = res.request();
    if (!["xhr", "fetch"].includes(req.resourceType()) || !/json/.test(res.headers()["content-type"] ?? "")) return;
    // Capped: a streaming or long-poll response never finishes, and one unbounded wait here
    // stalled a worker on one node for half an hour.
    const read = res.text().then((body) => ({ method: req.method(), url: res.url(), status: res.status(), body })).catch(() => null);
    net.bodies.push(Promise.race([read, new Promise((r) => setTimeout(() => r(null), 8000))]));
  });

  const sigOf = async (scopeCss = null) => (await page.evaluate(probe, { scopeCss, sigOnly: true })).signature;

  async function locate(p, el) {
    if (el.css) {
      const l = p.locator(`css=${el.css}`);
      if ((await l.count()) === 1 && (await l.isVisible().catch(() => false))) return l;
    }
    if (el.role && el.role !== "generic" && el.name) {
      const l = p.getByRole(el.role, { name: el.name, exact: true });
      if ((await l.count()) > (el.nth ?? 0)) return l.nth(el.nth ?? 0);
    }
    if (el.name) {
      const l = p.getByText(el.name, { exact: true });
      if (await l.count()) return l.first();
    }
    return null;
  }

  async function fire(el, kind) {
    if (kind === "redirect") return; // it happened on its own when the page loaded
    const l = await locate(page, el);
    if (!l) throw new Error(`replay: "${el.name || el.css}" not found`);
    if (kind === "hover") await l.hover({ timeout: 4000 });
    else await l.click({ timeout: 4000 });
    await settle(page, 2500);
  }

  /**
   * Put the browser on `n`: jump to the last URL-addressable page on its cheapest route, then
   * replay the clicks after it. When `n` is an overlay, its root is located fresh from what the
   * final step opened, because portal indexes move between renders.
   */
  async function reach(n) {
    const path = g.route(n.id);
    if (path === null) throw new Error("unreachable without a write");
    let from = path.length ? path[0].from : n.id;
    let rest = path;
    for (let i = path.length - 1; i >= 0; i--) {
      if (g.node(path[i].to).kind === "page") {
        from = path[i].to;
        rest = path.slice(i + 1);
        break;
      }
    }
    const start = g.node(from);
    const resp = await page.goto(start.href ?? start.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()} on ${start.href ?? start.url}`);
    if (!inScope(page.url(), scope)) throw new SessionLost(`landed on ${page.url()} (login lost or redirected out of scope)`);
    if (n.state?.startsWith("on-load:") && rest.length <= 1) return { scopeCss: n.info?.scope ?? null };
    recordOnLoad(start, await dismissOnLoad(page));
    let scopeCss = null;
    for (let i = 0; i < rest.length; i++) {
      const last = i === rest.length - 1;
      if (last && n.kind !== "page" && n.kind !== "state") await page.evaluate(markFloating, FLOATING_SEL);
      await fire(rest[i].element, rest[i].kind);
      if (last && n.kind !== "page" && n.kind !== "state") scopeCss = (await page.evaluate(newOverlays, FLOATING_SEL))[0]?.css ?? null;
    }
    await page.evaluate(clearMarks);
    return { scopeCss };
  }

  /** An overlay open on load is a node of its own, reached from its page by a free `redirect` edge. */
  function recordOnLoad(pageNode, overlays) {
    for (const ov of overlays) {
      const kind = KIND_OF_ROLE[ov.role] ?? "modal";
      const { node, isNew } = stateNode({ url: pageNode.href ?? pageNode.url, state: `on-load:${ov.name}`, signature: ov.signature, kind, label: `on load: ${ov.name}` });
      if (isNew) g.annotate(node.id, { scope: ov.css });
      g.addEdge({ from: pageNode.id, to: node.id, kind: "redirect", element: { name: "(opens on load)" } });
    }
  }

  /**
   * A surface on this URL already in the graph with the same skeleton, else a new node. An
   * in-place state matches the page itself too, so closing a modal leads back to its page
   * instead of minting a copy of it.
   */
  function stateNode({ url, state, signature, kind, label }) {
    const family = kind === "state" ? ["page", "state"] : [kind];
    const same = g.nodesAt(url).find((m) => family.includes(m.kind) && similarity(m.signature, signature) >= SAME_SURFACE);
    if (same) return { node: same, isNew: false };
    return g.addNode({ url, state, signature, kind, label });
  }

  function pending(n, c, why, blocked = []) {
    const key = createHash("sha1").update(`${n.template}|${c.role}|${c.name}|${blocked.map((b) => `${b.method} ${new URL(b.url).pathname}`).join(",")}`).digest("hex").slice(0, 12);
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    appendFileSync(pendingPath, JSON.stringify({ key, node: n.id, url: n.url, label: n.label, element: { role: c.role, name: c.name, css: c.css }, why, blocked }) + "\n");
  }

  async function readLink(n, c) {
    const href = canonicalUrl(c.href);
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth, href };
    const known = g.data.meta.links[href];
    if (known && g.data.nodes[known]) return { node: g.data.nodes[known], kind: "navigation", element, outcome: "known" };
    if (!inScope(href, scope)) {
      const { node } = g.addNode({ url: href, signature: ["out-of-scope"], inScope: false, label: `${c.name || href} (out of scope)` });
      g.data.meta.links[href] = node.id;
      return { node, kind: "navigation", element, outcome: "out-of-scope" };
    }
    const b = admit(g.data.meta.bounds, href);
    if (!b.ok) {
      const { node } = g.addNode({ url: href, signature: ["bounded"], bound: b.bound, label: `${new URL(href).pathname} (bounded)` });
      return { node, kind: "navigation", element, outcome: "bounded" };
    }
    await side.goto(c.href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(side);
    const onLoad = await dismissOnLoad(side);
    const final = side.url();
    if (!inScope(final, scope)) {
      const { node } = g.addNode({ url: final, signature: ["out-of-scope"], inScope: false, label: `${c.name || final} (redirects out of scope)` });
      g.data.meta.links[href] = node.id;
      return { node, kind: "navigation", element, outcome: "redirect-out" };
    }
    const r = await side.evaluate(probe, {});
    const { node } = g.addNode({ url: final, signature: r.signature, modules: r.modules, interactive: r.candidates.length, label: r.heading || r.title || new URL(final).pathname });
    g.data.meta.links[href] = node.id;
    recordOnLoad(node, onLoad);
    return { node, kind: "navigation", element, outcome: "page" };
  }

  /** Fire one element from `n` and say what happened. Returns whether the page must be re-reached. */
  async function tryElement(n, c, before) {
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth };
    const out = { outcome: "inert", children: [] };
    const link = (kind, node) => {
      g.addEdge({ from: n.id, to: node.id, kind, element });
      out.children.push(node.id);
    };
    const loc = await locate(page, c);
    if (!loc) return { ...out, outcome: "not-found", dirty: false };
    const urlBefore = canonicalUrl(page.url());

    if (c.haspopup || c.inNav) {
      await page.evaluate(markFloating, FLOATING_SEL);
      await loc.hover({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(350);
      const ov = (await page.evaluate(newOverlays, FLOATING_SEL))[0];
      if (ov) {
        const sig = await sigOf(ov.css);
        const kind = KIND_OF_ROLE[ov.role] ?? "overlay";
        const { node } = stateNode({ url: page.url(), state: `${kind}:${ov.name || c.name}`, signature: sig, kind, label: `${kind}: ${ov.name || c.name}` });
        link("hover", node);
        out.outcome = "hover-overlay";
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await page.evaluate(clearMarks);
    }

    await page.evaluate(markFloating, FLOATING_SEL);
    const mark = { blocked: net.blocked.length, popups: net.popups.length, dialogs: net.dialogs.length, downloads: net.downloads.length, failures: net.failures.length };
    current = { node: n.id, element: `${c.role} "${c.name.slice(0, 60)}"` };
    const expandedBefore = c.expanded;
    try {
      await loc.click({ timeout: 4000 });
    } catch (e) {
      await page.evaluate(clearMarks).catch(() => {});
      return { ...out, outcome: out.children.length ? out.outcome : "unclickable", error: e.message.split("\n")[0], dirty: false };
    }
    await settle(page, 2500);
    const blocked = net.blocked.slice(mark.blocked);
    const popups = net.popups.slice(mark.popups);
    const dialogs = net.dialogs.slice(mark.dialogs);
    const downloads = net.downloads.slice(mark.downloads);
    const viaWrite = blocked.length > 0;
    if (viaWrite) pending(n, c, "a click sent a write; it was aborted, so what opened is the failure path", blocked);
    let dirty = false;

    if (popups.length) {
      for (const url of popups) {
        const r = await readLink(n, { ...c, href: url });
        link("navigation", r.node);
      }
      out.outcome = "popup";
    } else if (canonicalUrl(page.url()) !== urlBefore) {
      dirty = true;
      const url = page.url();
      if (!inScope(url, scope)) {
        const { node } = g.addNode({ url, signature: ["out-of-scope"], inScope: false, label: `${c.name || url} (out of scope)` });
        link("navigation", node);
        out.outcome = "out-of-scope";
      } else {
        const b = admit(g.data.meta.bounds, url);
        if (!b.ok) {
          const { node } = g.addNode({ url, signature: ["bounded"], bound: b.bound, label: `${new URL(url).pathname} (bounded)` });
          link(viaWrite ? "write" : "click", node);
          out.outcome = "bounded";
        } else {
          const r = await page.evaluate(probe, {});
          const { node } = g.addNode({ url, signature: r.signature, modules: r.modules, interactive: r.candidates.length, label: r.heading || r.title || new URL(url).pathname });
          link(viaWrite ? "write" : "click", node);
          out.outcome = "navigation";
        }
      }
    } else {
      // A tooltip after a click is the pointer resting on something, not what the click opened.
      const ov = (await page.evaluate(newOverlays, FLOATING_SEL)).find((o) => o.role !== "tooltip");
      if (ov) {
        const sig = await sigOf(ov.css);
        const kind = KIND_OF_ROLE[ov.role] ?? "overlay";
        const { node } = stateNode({ url: page.url(), state: `${kind}:${ov.name || c.name}`, signature: sig, kind, label: `${kind}: ${ov.name || c.name}` });
        link(viaWrite ? "write" : "click", node);
        out.outcome = "overlay";
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        const still = (await page.evaluate(newOverlays, FLOATING_SEL)).length;
        if (still || similarity(before, await sigOf()) < SAME_STATE) dirty = true;
      } else {
        const after = await sigOf();
        const expandedAfter = await loc.getAttribute("aria-expanded").catch(() => null);
        if (similarity(before, after) < SAME_STATE || (expandedBefore !== expandedAfter && expandedAfter === "true")) {
          const { node } = stateNode({ url: page.url(), state: `${c.role}:${c.name}`, signature: after, kind: "state", label: `${c.role}: ${c.name}` });
          if (node.id !== n.id) {
            link(viaWrite ? "write" : "click", node);
            out.outcome = "state";
          }
          dirty = true;
        } else if (dialogs.length) out.outcome = `native-dialog: ${dialogs[0].slice(0, 80)}`;
        else if (downloads.length) out.outcome = `download: ${downloads[0]}`;
        else if (viaWrite) out.outcome = "write-attempt";
      }
    }
    await page.evaluate(clearMarks).catch(() => {});
    const failed = net.failures.slice(mark.failures).map((f) => `${f.kind} ${f.detail}`);
    current = { node: n.id, element: null };
    return { ...out, blocked: blocked.map((b) => `${b.method} ${b.url}`), failed: failed.length ? failed : undefined, dirty };
  }

  async function expandNode(n) {
    net.bodies = [];
    current = { node: n.id, element: "(load)" };
    const { scopeCss: fresh } = await reach(n);
    const scopeCss = fresh ?? n.info?.scope ?? null;
    const r = await page.evaluate(probe, { scopeCss });
    const bodies = (await Promise.all(net.bodies)).filter(Boolean);
    net.bodies = null;

    const rel = join("nodes", n.id);
    const art = join(dir, rel);
    mkdirSync(join(art, "xhr"), { recursive: true });
    await page.screenshot({ path: join(art, "screenshot.png"), fullPage: n.kind === "page", timeout: 20000 }).catch(() => {});
    writeFileSync(join(art, "dom.html"), await page.content());
    const aria = await page.locator(scopeCss ? `css=${scopeCss}` : "body").ariaSnapshot({ timeout: 20000 }).catch(() => "");
    writeFileSync(join(art, "aria.yml"), aria);
    const requests = bodies.map((b) => {
      const file = `${createHash("sha1").update(`${b.method} ${b.url}`).digest("hex").slice(0, 12)}.json`;
      if (b.body.length <= 2_000_000) writeFileSync(join(art, "xhr", file), b.body);
      return { method: b.method, url: b.url, status: b.status, bytes: b.body.length, file };
    });
    g.annotate(n.id, { title: r.title, heading: r.heading, interactive: r.candidates.length, artifacts: rel, scope: scopeCss, overflowX: r.overflowX });

    // A state or overlay re-exposes everything around it; only what is new to it is its own.
    const parentKeys = new Set();
    if (n.kind !== "page") {
      const path = g.route(n.id) ?? [];
      const parent = path.length ? g.data.nodes[path[path.length - 1].from] : null;
      for (const k of parent?.info?.candidateKeys ?? []) parentKeys.add(k);
    }
    const keyOf = (c) => `${c.role}|${c.name}|${repeatGroup(c.css)}`;
    const groupSize = new Map();
    for (const c of r.candidates) if (!c.href) groupSize.set(repeatGroup(c.css), (groupSize.get(repeatGroup(c.css)) ?? 0) + 1);
    const groups = new Map();
    const outcomes = [];
    let before = await sigOf();

    // Template sampling: once two members of this template are closed, a member fires only
    // the controls no member has fired yet (names with their digits normalised). One listing's
    // calendar of 594 controls took four minutes; the next sixteen added nothing new.
    const tmpl = g.data.templates[n.template];
    const seenKeys = new Set(tmpl.seenKeys ?? []);
    const closedSiblings = tmpl.members.filter((id) => id !== n.id && ["closed", "built", "verified"].includes(g.data.nodes[id].status)).length;
    const templateSampled = closedSiblings >= TEMPLATE_SAMPLE;
    const normKey = (c) => `${c.role}|${c.name.replace(/\d+([.,]\d+)*/g, "#")}|${repeatGroup(c.css)}`;
    let skippedByTemplate = 0;

    for (const c of r.candidates) {
      const row = { role: c.role, name: c.name, css: c.css, href: c.href };
      if (templateSampled && seenKeys.has(normKey(c))) {
        skippedByTemplate++;
        outcomes.push({ ...row, outcome: "template-seen" });
        continue;
      }
      seenKeys.add(normKey(c));
      if (parentKeys.has(keyOf(c))) {
        outcomes.push({ ...row, outcome: "inherited" });
        continue;
      }
      if (c.disabled || c.field || c.options) {
        outcomes.push({ ...row, outcome: c.disabled ? "disabled" : c.options ? "select" : "field", options: c.options ?? undefined });
        continue;
      }
      const safety = classify(c);
      if (safety.verdict === "never" || (safety.verdict === "risky" && risky !== "probe")) {
        pending(n, c, safety.why);
        outcomes.push({ ...row, outcome: `skipped:${safety.verdict}` });
        continue;
      }

      const shellKey = `${keyOf(c)}`;
      const shell = g.data.meta.shellClicks[shellKey];
      if (!c.href && shell && shell.pages.length >= 2 && !shell.pages.includes(n.template)) {
        outcomes.push({ ...row, outcome: `shell: expanded on ${shell.pages.length} templates` });
        continue;
      }

      const grp = repeatGroup(c.css);
      if (!c.href && (groupSize.get(grp) ?? 0) > STATE_BOUND) {
        const G = groups.get(grp) ?? { tried: 0, leads: new Set() };
        groups.set(grp, G);
        if ((G.tried >= sample && G.leads.size <= 1) || G.tried >= STATE_BOUND) {
          outcomes.push({ ...row, outcome: "sampled-out" });
          continue;
        }
        G.tried++;
      }

      let res;
      try {
        if (c.href && !c.href.startsWith("javascript:") && canonicalUrl(c.href) !== canonicalUrl(page.url())) {
          const l = await readLink(n, c);
          g.addEdge({ from: n.id, to: l.node.id, kind: l.kind, element: l.element });
          res = { outcome: l.outcome, children: [l.node.id], dirty: false };
        } else {
          res = await tryElement(n, c, before);
          // A write verb that sent nothing still needs its write path captured once.
          if (safety.verdict === "write-verb" && !res.blocked?.length) pending(n, c, `${safety.why}; the click sent no request (a next step, or client-side state)`);
        }
      } catch (e) {
        if (e instanceof SessionLost) throw e;
        res = { outcome: "error", error: e.message.split("\n")[0], children: [], dirty: true };
      }
      const G = groups.get(grp);
      if (G) G.leads.add(res.children.map((id) => g.data.nodes[id]?.template).join(",") || res.outcome);
      if (!c.href) {
        const s = (g.data.meta.shellClicks[shellKey] ??= { pages: [] });
        if (!s.pages.includes(n.template)) s.pages.push(n.template);
      }
      outcomes.push({ ...row, ...res, dirty: undefined });
      if (res.dirty) {
        await reach(n);
        before = await sigOf();
      }
    }

    const sampled = [...groups].filter(([grp, G]) => G.tried < groupSize.get(grp)).map(([grp, G]) => ({ group: grp, of: groupSize.get(grp), tried: G.tried }));
    tmpl.seenKeys = [...seenKeys];
    g.annotate(n.id, { candidateKeys: r.candidates.map(keyOf), sampled: sampled.length ? sampled : undefined, templateSeen: skippedByTemplate || undefined });
    writeFileSync(join(art, "inventory.json"), JSON.stringify({ id: n.id, url: n.url, state: n.state, kind: n.kind, title: r.title, requests, candidates: outcomes }, null, 1));
    return outcomes;
  }

  let done = 0;
  let netDown = 0;
  let stopping = false;
  const stop = () => (stopping = true);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (done < maxNodes && !stopping) {
      const n = g.next();
      if (!n) break;
      if (!mine(n)) {
        n.status = "frontier";
        deferred.push(n.id);
        continue;
      }
      // Reached only through a write (aborted while walking the reference): not replayable, and
      // not a failure. Closed as bounded; its write waits in pending-writes.jsonl for BLOCKED.
      if (g.route(n.id) === null) {
        g.setStatus(n.id, "bounded", "reached only through a write: see pending-writes.jsonl");
        n.bound = "reached only through a write";
        save(g, dir);
        continue;
      }
      const t = Date.now();
      try {
        const outs = await expandNode(n);
        g.setStatus(n.id, "closed");
        const opened = outs.filter((o) => o.children?.length).length;
        log(`closed ${n.id} ${n.kind.padEnd(6)} ${n.label.slice(0, 60)}  elements ${outs.length}, opened ${opened}, ${((Date.now() - t) / 1000).toFixed(1)}s  frontier ${g.frontier.size}`);
      } catch (e) {
        if (e instanceof SessionLost) {
          g.setStatus(n.id, "frontier");
          save(g, dir);
          throw e;
        }
        if (stopping || BROWSER_GONE.test(e.message)) {
          g.setStatus(n.id, "frontier");
          log(`stopped: ${stopping ? "signal" : "the browser went away"}; ${n.id} back on the frontier`);
          break;
        }
        if (NETWORK_GONE.test(e.message)) {
          g.setStatus(n.id, "frontier");
          netDown++;
          log(`network down (${netDown}); ${n.id} back on the frontier, waiting 30 s`);
          if (netDown >= 20) {
            log("stopped: network down for ten minutes");
            break;
          }
          save(g, dir);
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }
        netDown = 0;
        n.attempts = (n.attempts ?? 0) + 1;
        if (n.attempts >= 2) g.setStatus(n.id, "gap", `explore failed twice: ${e.message.split("\n")[0]}`);
        else g.setStatus(n.id, "frontier");
        log(`failed ${n.id} ${n.label.slice(0, 60)}: ${e.message.split("\n")[0]}`);
      }
      save(g, dir);
      done++;
    }
  } finally {
    for (const id of deferred) g.setStatus(id, "frontier");
    save(g, dir);
    // Attached over CDP the browser is the human's: leave it as it was found.
    await side.close().catch(() => {});
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await close();
  }
  const open = Object.values(g.data.nodes).filter((n) => n.status === "frontier" && mine(n)).length;
  return { expanded: done, closed: g.isClosed(), ownOpen: onlyPrefix ? open : undefined };
}

/** Read one URL as an entry node (used by `run.mjs init` and `run.mjs visit`). */
export async function readEntry(g, url, opts = {}) {
  const { context, close } = await openReference(opts);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await settle(page);
    await dismissOnLoad(page); // recorded as nodes when the entry is expanded
    const r = await page.evaluate(probe, {});
    return g.addNode({ url: page.url(), signature: r.signature, modules: r.modules, interactive: r.candidates.length, entry: true, label: r.heading || r.title || new URL(page.url()).pathname });
  } finally {
    await close();
  }
}
