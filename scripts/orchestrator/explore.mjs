// The explore loop (orchestrator step 3): pop a node, reach it by its cheapest replay route,
// read it, fire every element once, record what each one opened, push the children, close the
// node, save. Repeats until the frontier is empty or the run's node budget is spent; a later
// run resumes from graph.json with nothing lost or repeated.
//
// Safety is in safety.mjs: names that end the session are never clicked, money/messaging/
// deletion names are queued for BLOCKED, every non-read request (HTTP or websocket call) is
// aborted in the browser (POSTs a page sends while loading are reads unless clearly named
// writes), analytics beacons are dropped, and a route that signed the session out is put in
// never-open.jsonl and never opened again.
//
// Four invariants this file keeps, each with a test in test/walker.test.mjs:
//   - an element fires only from its node's verified pre-state, and what it opened is read
//     from the diff against that state (else it is `unfired: state-not-restored`, not an edge);
//   - an edge is a `write` only when a request it sent is a write, never a read POST;
//   - a lost login stops the run (SessionLost, exit 3) with the node back on the frontier, a
//     transient error is retried with backoff, and every gap carries a machine-readable reason;
//   - a node closes only when every element on it is an edge or a recorded reason, for every
//     interaction kind that applies to it (click, right-click, double-click, key, drag, input,
//     submit, upload: interactions.mjs, test/interactions.test.mjs).

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openReference, settle } from "../lib/pw.mjs";
import { similarity } from "./algorithms.mjs";
import { STATE_BOUND, admit, inScope, repeatGroup } from "./bound.mjs";
import { KEYED_KINDS, scopeByRules } from "./graph.mjs";
import { INTERACTION_UNFIRED, LISTENER_HOOK, focusOrder, interactionInvariant, locateFor, perform, readShortcuts, replayEdge, runInteractions } from "./interactions.mjs";
import { DEFAULT_WIDTHS, readLabels } from "../qa/labels.mjs";
import { FLOATING_SEL, clearMarks, markFloating, newOverlays, openFloating, openOnLoad, probe, sessionState, styleManifest } from "./page-probe.mjs";
import { NeverOpen, RequestClassifier, classify, classifyFrame, pairFrames, parseFrame, sessionEndingUrl } from "./safety.mjs";
import { TRANSIENT_ERR, failureReason, markGap } from "./gaps.mjs";
import { save } from "./store.mjs";

/** Below this skeleton similarity, a click that kept the URL made a new state. */
export const SAME_STATE = 0.97;
/** At or above it, two readings on one URL are the same surface. */
export const SAME_SURFACE = 0.995;
/** Repeated siblings sampled from a group larger than STATE_BOUND before stopping. */
export const SAMPLE = 5;
/** Members of one template expanded in full before the rest fire only what is new to it. */
export const TEMPLATE_SAMPLE = 2;

/** Tries of one navigation that met a transient error (5xx, "service unavailable", a timeout). */
export const RETRIES = 3;
/** First backoff between those tries; it doubles each time. */
export const BACKOFF_MS = 1500;

export class SessionLost extends Error {}
/**
 * A navigation that signed the session out (it landed on a logout-like URL). `target` is the URL
 * that was opened; it is in never-open.jsonl before this is thrown. A SessionLost, so the run
 * exits 3 for a new login.
 */
export class SessionEnding extends SessionLost {
  constructor(message, { target, landed }) {
    super(message);
    this.target = target;
    this.landed = landed;
  }
}
/** A navigation refused before it left: its URL is in never-open.jsonl. */
export class NeverOpenError extends Error {}
/** A navigation that kept failing transiently after every retry. */
export class TransientError extends Error {}
/** A node whose elements are not all accounted for: it must not close. */
export class InvariantError extends Error {}

/** Sign-in pages and identity hosts. `--login-pattern` overrides it for an unusual login URL. */
export const LOGIN_URL = /(^https?:\/\/(login|auth|sso|idp|signin|accounts)[.-])|\/(login|log-in|signin|sign-in|sign_in|logon|authn?|sso|saml2?|oauth2?|openid|adfs|cas|idp)(\/|\?|#|\.|$)/i;
const SIGN_IN_NAME = /\b(sign|log)\s*-?\s*in\b/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- what every element ends as ----------

/** Fired, and opened something: the outcome carries `children`, one edge each. */
export const EDGE_OUTCOMES = new Set(["navigation", "page", "known", "out-of-scope", "redirect-out", "bounded", "popup", "overlay", "hover-overlay", "state", "unreachable", "session-ending"]);
/** Fired, and the result is recorded without an edge. */
export const FIRED_OUTCOMES = new Set(["inert", "write-attempt"]);
const FIRED_PREFIX = /^(native-dialog|download): /;
/** Not fired, with the reason it was not. */
export const UNFIRED_REASONS = new Set([
  "disabled", "field", "select", "skipped:never", "skipped:risky", "inherited", "template-seen", "sampled-out",
  "state-not-restored", "not-found", "unclickable", "error", "shallow", ...INTERACTION_UNFIRED,
]);
const UNFIRED_PREFIX = /^shell: /;
const knownUnfired = (r) => UNFIRED_REASONS.has(r) || UNFIRED_PREFIX.test(r ?? "");

/**
 * Every candidate the probe found must end as exactly one row, and each row as an edge (with
 * its children), a fired result, or an unfired reason. Returns the violations; empty is closed.
 */
export function nodeInvariant(candidates, outcomes) {
  const bad = [];
  if (outcomes.length !== candidates.length) bad.push(`${candidates.length} element(s) found, ${outcomes.length} accounted for`);
  candidates.forEach((c, i) => {
    const o = outcomes[i];
    const who = `${c.role} "${(c.name ?? "").slice(0, 40)}"`;
    if (!o || o.css !== c.css || o.name !== c.name) return bad.push(`${who}: no row`);
    if (EDGE_OUTCOMES.has(o.outcome)) {
      if (!o.children?.length) bad.push(`${who}: outcome ${o.outcome} without an edge`);
    } else if (FIRED_OUTCOMES.has(o.outcome) || FIRED_PREFIX.test(o.outcome)) {
      // fired, recorded
    } else if (o.unfired !== undefined) {
      if (!UNFIRED_REASONS.has(o.unfired) && !UNFIRED_PREFIX.test(o.unfired ?? "")) bad.push(`${who}: unfired without a known reason (${o.unfired})`);
    } else bad.push(`${who}: unknown outcome ${o.outcome}`);
  });
  return bad;
}

/**
 * An unfired row. `unfired` is the reason; `outcome` repeats it, the field compare.mjs and older
 * readers key on (`disabled`, `inert`, ...).
 */
const unfired = (row, reason, extra = {}) => ({ ...row, ...extra, outcome: reason, unfired: reason });
const isUnfired = (res) => res.unfired !== undefined;

// Gap reasons, `requeue --gaps`, `requeue --risky`: gaps.mjs (re-exported here for callers).
export { failureReason, gapReason, markGap, requeueGaps, requeueRisky, requeueWriteOnly, retryableGaps } from "./gaps.mjs";

/** The browser itself went away (a stop signal, a crash): not the node's fault, end the run. */
const BROWSER_GONE = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected|Target crashed/i;
/** The machine lost its network: wait and retry the node, never count it against the node. */
const NETWORK_GONE = /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_RESET/;

const DISMISS = /^(close|dismiss|skip( tour)?|got it|no,? thanks|not now|maybe later|later|ok(ay)?|accept( all)?|×|✕|x)$/i;

/**
 * Close whatever opened on load, reading each overlay first. Escape, then the overlay's own
 * dismiss control. Returns what was open, with its skeleton, so the caller can record it.
 */
export async function dismissOnLoad(p, { onAct = null } = {}) {
  const seen = [];
  for (let round = 0; round < 3; round++) {
    const [ov] = await p.evaluate(openOnLoad);
    if (!ov || seen.some((s) => s.name === ov.name)) break;
    const read = await p.evaluate(probe, { scopeCss: ov.css, sigOnly: true });
    ov.signature = read.signature;
    ov.contentKey = read.contentKey;
    seen.push(ov);
    onAct?.();
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

/**
 * Options beyond the original ones (the CLI flag each one needs is in parentheses):
 *   retries      tries of a navigation that met a transient error (`--retries N`, default 3)
 *   backoffMs    first wait between them, doubling (`--backoff-ms N`, default 1500)
 *   loginPattern regex source for sign-in URLs (`--login-pattern <regex>`)
 *   wsGuard      "block" (default): websocket calls that are not reads are dropped in the
 *                browser; "off": frames are only recorded (`--ws-guard block|off`)
 *   widths       widths each node's structural labels are read at for Phase D, besides the
 *                capture width (`--widths 1024,1280,...` or `--widths off`; default DEFAULT_WIDTHS)
 */
export async function explore(g, dir, opts = {}) {
  const {
    maxNodes = Infinity, risky = "record", allowPost = [], readPosts = "off", pace = 0, sample = SAMPLE, onlyPrefix = null,
    retries = RETRIES, backoffMs = BACKOFF_MS, loginPattern = null, wsGuard = "block", widths = DEFAULT_WIDTHS, log = (s) => console.error(s),
    keyboards = null, walkScope = null, entries = [], interactions = true, stateBound = STATE_BOUND,
  } = opts;
  // Documented shortcuts (a keyboards.json path or its parsed document), fired on every template.
  const shortcuts = keyboards ? readShortcuts(typeof keyboards === "string" ? JSON.parse(readFileSync(keyboards, "utf8")) : keyboards) : null;
  // Writes allowed (the clone, walked with --allow-post): file inputs get real uploads.
  const writesAllowed = allowPost.length > 0;
  if (walkScope) g.setWalkScope(walkScope);
  const entryUrls = () => new Set(Object.values(g.data.nodes).filter((n) => n.entry).map((n) => n.url));
  // A bound never holds an entry page or an in-scope page: put back any an earlier walk bounded.
  for (const n of Object.values(g.data.nodes)) {
    if (n.status !== "bounded" || !n.bound || /through a write/.test(n.bound)) continue;
    if (n.entry || (g.data.meta.walkScope && g.inWalk(n))) {
      n.bound = null;
      g.setStatus(n.id, "frontier", null);
    }
  }
  const sweep = widths === "off" ? [] : [widths].flat().map(Number).filter((w) => w > 0);
  const loginRe = loginPattern ? new RegExp(loginPattern, "i") : LOGIN_URL;
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

  // Read POSTs: one classifier for "may this request leave the browser" and "is this edge a
  // write". Learned rules are logged to allowed-posts.jsonl and reloaded on the next run.
  const allowedPath = join(dir, "allowed-posts.jsonl");
  const reqs = new RequestClassifier({ allowPost, readPosts, origin: g.data.meta.origin ?? null, onLearn: (row) => appendFileSync(allowedPath, JSON.stringify({ ...row, node: current.node, element: current.element }) + "\n") });
  if (existsSync(allowedPath)) reqs.load(readFileSync(allowedPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }));

  const { context, close } = await openReference(opts);
  // Which elements listen for a right-click, a double-click, a drag or keys (interactions.mjs).
  await context.addInitScript({ content: LISTENER_HOOK });
  const net = { blocked: [], reads: 0, popups: [], dialogs: [], downloads: [], bodies: null, ws: null, failures: [], refused: [] };
  // URLs no walk may open again (they signed the session out once): refused before every navigation.
  const never = new NeverOpen(join(dir, "never-open.jsonl"));
  // Per page: "load" from a document load until the walker acts on it (a click, a key, a hover,
  // a dismiss), then "action". A POST sent at load is a read unless its name is a clear write
  // (safety.mjs). Only a document request starts a load: a hash or pushState change inside a
  // click stays "action", so a click that routes and writes at once is still aborted. `navs`
  // lists the main-frame URLs since the last act, so a redirect through a logout route is seen.
  const phase = new WeakMap();
  const navs = new WeakMap();
  const acting = (p) => {
    phase.set(p, "action");
    navs.set(p, []);
  };
  const addNav = (p, url) => navs.set(p, [...(navs.get(p) ?? []), url]);
  // Broken flows: an API answer >= 400 or an uncaught script error, tied to the node and the
  // click that caused it, in errors.jsonl. A walk that only records what opened misses a save
  // that 500s behind a toast.
  const errorsPath = join(dir, "errors.jsonl");
  let current = { node: null, element: null };
  const failure = (kind, detail) => {
    const row = { kind, detail, node: current.node, element: current.element };
    net.failures.push(row);
    appendFileSync(errorsPath, JSON.stringify(row) + "\n");
    g.signal("walker.error", { node: current.node, element: current.element, kind, detail: String(detail ?? "").slice(0, 300) });
  };
  await context.route("**/*", (route) => {
    const req = route.request();
    let from = null;
    try {
      from = req.frame().page();
    } catch {}
    if (req.isNavigationRequest() && never.match(req.url())) {
      net.refused.push(req.url());
      return route.abort("blockedbyclient");
    }
    const ph = (from && phase.get(from)) ?? "action";
    const v = reqs.classify({ method: req.method(), url: req.url(), postData: req.postData(), phase: ph });
    if (v.verdict === "write") {
      net.blocked.push({ method: req.method(), url: req.url(), body: (req.postData() ?? "").slice(0, 2000), why: v.why, phase: ph });
      return route.abort("blockedbyclient");
    }
    // A document load that may go ahead: what the page sends from now until the next act is load.
    if (from && req.isNavigationRequest() && req.frame() === from.mainFrame()) {
      phase.set(from, "load");
      addNav(from, req.url());
    }
    // Analytics beacons: not sent (they record the walk as usage), not a write either.
    if (v.verdict === "telemetry") return route.abort("blockedbyclient");
    // A non-read method let through as a read: logged, so a person can confirm each one is.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method().toUpperCase())) {
      net.reads++;
      appendFileSync(allowedPath, JSON.stringify({ method: req.method(), url: req.url(), why: v.why, phase: ph, node: current.node, element: current.element }) + "\n");
    }
    return route.fallback();
  });

  // Websocket RPC: many apps read most of their data over a socket. Every frame is recorded per
  // node next to the HTTP reads; a sent call that is not a read is dropped, like an HTTP write.
  const onFrame = (f) => {
    if (net.ws && net.ws.length < 2000) net.ws.push(f);
  };
  const sentFrame = (url, data) => {
    const parsed = parseFrame(typeof data === "string" ? data : null);
    const v = parsed ? classifyFrame(parsed, allowPost) : { verdict: "read" };
    onFrame({ dir: "sent", url, data: typeof data === "string" ? data.slice(0, 2_000_000) : "(binary)", parsed, verdict: v.verdict });
    if (v.verdict === "write") net.blocked.push({ method: "WS", url: `${url}#${parsed.name}`, body: String(data).slice(0, 2000), why: v.why });
    return v.verdict === "read";
  };
  const recvFrame = (url, data) => onFrame({ dir: "recv", url, data: typeof data === "string" ? data.slice(0, 2_000_000) : "(binary)", parsed: parseFrame(typeof data === "string" ? data : null) });
  if (wsGuard !== "off") {
    await context.routeWebSocket(/.*/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((data) => {
        if (sentFrame(ws.url(), data)) server.send(data);
      });
      server.onMessage((data) => {
        recvFrame(ws.url(), data);
        ws.send(data);
      });
    });
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const side = await context.newPage();
  for (const p of [page, side]) {
    phase.set(p, "load");
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) addNav(p, f.url());
    });
    p.on("dialog", (d) => {
      net.dialogs.push(d.message());
      d.dismiss().catch(() => {});
    });
    p.on("download", (d) => {
      net.downloads.push(d.suggestedFilename());
      d.cancel().catch(() => {});
    });
  }
  if (wsGuard === "off") {
    page.on("websocket", (ws) => {
      ws.on("framesent", ({ payload }) => sentFrame(ws.url(), payload));
      ws.on("framereceived", ({ payload }) => recvFrame(ws.url(), payload));
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
    // The request body too: an app that reads through POST carries the filter in it, and the
    // clone's API has to accept the same shape.
    const read = res.text().then((body) => ({ method: req.method(), url: res.url(), status: res.status(), body, reqBody: req.postData() ?? null })).catch(() => null);
    net.bodies.push(Promise.race([read, new Promise((r) => setTimeout(() => r(null), 8000))]));
  });

  const sigOf = async (scopeCss = null) => (await page.evaluate(probe, { scopeCss, sigOnly: true })).signature;
  /** Skeleton plus content key (page-probe.mjs `contentKey`), for a surface about to become a node. */
  const readOf = async (scopeCss = null) => page.evaluate(probe, { scopeCss, sigOnly: true });

  // ---------- session and transient errors, on every navigation ----------

  /**
   * Read where `p` is. Throws SessionLost on a sign-in page or a session-ended notice, unless
   * the navigation asked for a sign-in page itself (a "Log in" link on a public page). Returns
   * "transient" for an error page worth retrying.
   */
  async function checkPage(p, { requested = null, byName = "" } = {}) {
    // A navigation that landed on (or passed through) a logout-like URL signed the session out:
    // the URL that was opened goes into never-open.jsonl and the run stops for a new login.
    const chain = [...(navs.get(p) ?? []), p.url()].filter((u) => u && u !== "about:blank");
    const ending = chain.find(sessionEndingUrl);
    if (ending && !(requested && sessionEndingUrl(requested))) {
      const target = requested ?? chain.find((u) => !sessionEndingUrl(u)) ?? ending;
      throw sessionEnding(target, ending, "the navigation landed on a session-ending URL");
    }
    const st = await p.evaluate(sessionState, { loginSrc: loginRe.source }).catch(() => null);
    if (!st) return null;
    if (st.transient) return { transient: true, login: st.login, why: st.why, href: st.href };
    const askedForLogin = (requested && loginRe.test(requested)) || SIGN_IN_NAME.test(byName);
    if ((st.login || st.ended) && !askedForLogin) {
      // One hop to the sign-in page from a URL that was opened: session-ending when the login is
      // still alive elsewhere (the URL itself throws the session out); else the login is simply
      // gone and nothing can be blamed.
      const target = requested ?? chain.find((u) => !loginRe.test(u)) ?? null;
      if (st.login && target && (await sessionAlive())) throw sessionEnding(target, st.href, "the navigation led to the sign-in page while the session was alive", { alive: true });
      throw new SessionLost(`${st.why} at ${st.href}`);
    }
    return null;
  }

  /** Record `target` as never-open and build the error to throw (`alive`: the login survived). */
  function sessionEnding(target, landed, why, { alive = false } = {}) {
    never.add(target, { landed, why, node: current.node, element: current.element });
    const e = new SessionEnding(`session-ending: opening ${target} ${alive ? "led to" : "landed on"} ${landed}`, { target, landed });
    e.alive = alive;
    return e;
  }

  /** Is the login still good? An entry page read in a fresh tab, never the walker's own. */
  async function sessionAlive() {
    const entry = Object.values(g.data.nodes).find((n) => n.entry);
    if (!entry) return false;
    const t = await context.newPage();
    try {
      await t.goto(entry.href ?? entry.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await settle(t);
      const st = await t.evaluate(sessionState, { loginSrc: loginRe.source }).catch(() => null);
      return !!st && !st.login && !st.ended && !st.transient;
    } catch {
      return false;
    } finally {
      await t.close().catch(() => {});
    }
  }

  /**
   * Navigate `p` to `url` and settle, retrying transient failures (5xx, a "service unavailable"
   * page, a timeout, an aborted load) with doubling backoff. `fresh` forces a real load when the
   * page is already on that URL (a hash route would otherwise not reload). Returns the response.
   */
  async function load(p, url, { fresh = false } = {}) {
    if (never.match(url)) throw new NeverOpenError(`never-open: ${url} matches never-open.jsonl (it signed the session out once)`);
    let last = "";
    let onLogin = false;
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(backoffMs * 2 ** (i - 1));
      try {
        if (fresh || i) await p.goto("about:blank").catch(() => {});
        navs.set(p, []);
        const resp = await p.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await settle(p);
        const status = resp?.status() ?? 0;
        const st = await checkPage(p, { requested: url });
        if (st?.transient || status >= 500 || status === 429 || status === 408) {
          last = `HTTP ${status || "?"} on ${url}${st?.transient ? ` (${st.why} at ${st.href})` : ""}`;
          onLogin = !!st?.login;
          continue;
        }
        return resp;
      } catch (e) {
        if (e instanceof SessionLost || BROWSER_GONE.test(e.message) || NETWORK_GONE.test(e.message)) throw e;
        // A load cut short by a redirect to sign-in shows up as ERR_ABORTED: look where it landed.
        const st = await checkPage(p, { requested: url });
        if (!st?.transient && !TRANSIENT_ERR.test(e.message)) throw e;
        last = e.message.split("\n")[0];
        onLogin = !!st?.login;
      }
    }
    if (onLogin) throw new SessionLost(`still on a sign-in host after ${retries + 1} tries: ${last}`);
    throw new TransientError(`transient after ${retries + 1} tries: ${last}`);
  }

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
    acting(page);
    await replayEdge(page, { kind, element: el }, locate);
    await settle(page, 2500);
    await checkPage(page, { byName: el.name ?? "" });
  }

  /**
   * Put the browser on `n`: jump to the last URL-addressable page on its cheapest route, then
   * replay the clicks after it. When `n` is an overlay, its root is located fresh from what the
   * final step opened, because portal indexes move between renders.
   */
  async function reach(n, { fresh = false } = {}) {
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
    const resp = await load(page, start.href ?? start.url, { fresh });
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()} on ${start.href ?? start.url}`);
    if (!inScope(page.url(), scope)) throw new SessionLost(`landed on ${page.url()} (login lost or redirected out of scope)`);
    if (n.state?.startsWith("on-load:") && rest.length <= 1) return { scopeCss: n.info?.scope ?? null };
    recordOnLoad(start, await dismissOnLoad(page, { onAct: () => acting(page) }));
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

  // ---------- a node's pre-state ----------

  /** The page as an element will be fired from: its URL, skeleton, and what floats on it. */
  const preState = async () => ({ url: page.url(), sig: await sigOf(), floating: await page.evaluate(openFloating, FLOATING_SEL) });
  const floatKeys = (s) => s.floating.map((f) => f.key).join("\n");
  const samePre = (base, now) => now.url === base.url && floatKeys(now) === floatKeys(base) && similarity(base.sig, now.sig) >= SAME_STATE;

  /**
   * Bring the page back to the node's pre-state and prove it: as left, else Escape, else each
   * extra overlay's own close control, else a real reload of the node's route. Returns
   * `{ ok, pre }`, `pre` being the verified state the next element fires from.
   */
  async function restore(n, base) {
    let now = await preState();
    if (samePre(base, now)) return { ok: true, pre: now };
    if (now.url === base.url) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
      now = await preState();
      if (samePre(base, now)) return { ok: true, pre: now };
      const baseKeys = new Set(base.floating.map((f) => f.key));
      for (const f of now.floating.filter((x) => !baseKeys.has(x.key) && x.close)) {
        await page.locator(`css=${f.close}`).first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
      }
      now = await preState();
      if (samePre(base, now)) return { ok: true, pre: now };
    }
    await reach(n, { fresh: true });
    now = await preState();
    return { ok: samePre(base, now), pre: now };
  }

  /** An overlay open on load is a node of its own, reached from its page by a free `redirect` edge. */
  function recordOnLoad(pageNode, overlays) {
    for (const ov of overlays) {
      const kind = KIND_OF_ROLE[ov.role] ?? "modal";
      const { node, isNew } = stateNode({ url: pageNode.href ?? pageNode.url, state: `on-load:${ov.name}`, signature: ov.signature, contentKey: ov.contentKey, kind, label: `on load: ${ov.name}` });
      if (isNew) g.annotate(node.id, { scope: ov.css });
      g.addEdge({ from: pageNode.id, to: node.id, kind: "redirect", element: { name: "(opens on load)" } });
    }
  }

  /**
   * A surface on this URL already in the graph with the same skeleton and the same content key,
   * else a new node. Two confirms with one markup and different words are two nodes (one
   * template). An in-place state matches the page itself too (a page has no key), so closing a
   * modal leads back to its page instead of minting a copy of it. A node from an older graph has
   * no key: the first surface that matches it by skeleton gives it its key, so a look-alike with
   * another key then becomes a node of its own.
   */
  function stateNode({ url, state, signature, kind, label, contentKey = null }) {
    const family = kind === "state" ? ["page", "state"] : [kind];
    const alike = g.nodesAt(url).filter((m) => family.includes(m.kind) && similarity(m.signature, signature) >= SAME_SURFACE);
    const keyed = (m) => m.kind === "page" || !contentKey;
    const same = alike.find((m) => keyed(m) || m.contentKey === contentKey) ?? alike.find((m) => !m.contentKey);
    if (same) {
      if (contentKey && !same.contentKey && same.kind !== "page") same.contentKey = contentKey;
      return { node: same, isNew: false };
    }
    return g.addNode({ url, state, signature, kind, label, contentKey });
  }

  /** An out-of-scope destination: a gap node, with its reason. */
  function outNode(url, label) {
    const r = g.addNode({ url, signature: ["out-of-scope"], inScope: false, label });
    if (r.isNew) r.node.gapReason = { code: "out-of-scope", retryable: false, message: url };
    return r;
  }

  /**
   * One row of pending-writes.jsonl. `kind` says why: `write` (a request was aborted), `risky-name`
   * (not clicked), `write-verb` (a write name that sent nothing at all).
   */
  function pending(n, c, why, blocked = [], kind = blocked.length ? "write" : "risky-name") {
    const key = createHash("sha1").update(`${n.template}|${c.role}|${c.name}|${blocked.map((b) => `${b.method} ${new URL(b.url).pathname}`).join(",")}`).digest("hex").slice(0, 12);
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    appendFileSync(pendingPath, JSON.stringify({ key, kind, node: n.id, url: n.url, label: n.label, element: { role: c.role, name: c.name, css: c.css }, why, blocked }) + "\n");
  }

  /**
   * STATE_BOUND for a discovered URL. It never bounds an entry page or a page in the walk's
   * scope: a bound samples repeated row siblings, it is not a reason to leave a working screen
   * unwalked (a key planner page stayed `bounded` on a 400-node walk).
   */
  function admitUrl(url) {
    const canon = g.canon(url);
    if (entryUrls().has(canon)) return { ok: true };
    const ws = g.data.meta.walkScope;
    if (ws && ws.ids.includes(scopeByRules(ws.rules, { url: canon, href: url, kind: "page", label: "" }))) return { ok: true };
    return admit(g.data.meta.bounds, url, stateBound, { anyHash: !!g.data.meta.hashRoutes });
  }

  /**
   * A URL that signed the session out (or is in never-open.jsonl): every node at it becomes a gap
   * `session-ending`, every edge into it a `session-ending` edge (never replayed), and the opener
   * gets one too. Returns the node that stands for it.
   */
  function endingNode(url, why, opener = null) {
    const at = g.nodesAt(url);
    const node = at[0] ?? g.addNode({ url, signature: ["session-ending"], inScope: inScope(url, scope), label: `${new URL(url).pathname} (session-ending)` }).node;
    const ids = new Set(at.length ? at.map((m) => m.id) : [node.id]);
    for (const id of ids) if (g.node(id).status !== "gap" || g.node(id).gapReason?.code !== "session-ending") markGap(g, id, { code: "session-ending", retryable: false }, why);
    for (const e of Object.values(g.data.edges)) {
      if (!ids.has(e.to) || e.kind === "session-ending") continue;
      g.removeEdge(e.id);
      g.addEdge({ from: e.from, to: e.to, kind: "session-ending", element: e.element });
    }
    g.data.meta.links[g.canon(url)] = node.id;
    if (opener) g.addEdge({ from: opener.from, to: node.id, kind: "session-ending", element: opener.element });
    return node;
  }

  /** Record a SessionEnding thrown while firing `c` on `n`: an edge row, or a rethrow when the login is gone. */
  function ended(n, c, e) {
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth };
    const node = endingNode(e.target, `${e.message}`, { from: n.id, element });
    if (!e.alive) throw e;
    return { outcome: "session-ending", children: [node.id], landed: e.landed };
  }

  async function readLink(n, c) {
    const href = g.canon(c.href);
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth, href };
    // Never opened again once it signed the session out: the edge says so, nothing is loaded.
    const barred = never.match(c.href) ?? never.match(href);
    if (barred) return { node: endingNode(c.href, `never-open: ${barred.pattern}`), kind: "session-ending", element, outcome: "session-ending" };
    const known = g.data.meta.links[href];
    if (known && g.data.nodes[known]) return { node: g.data.nodes[known], kind: "navigation", element, outcome: "known" };
    if (!inScope(href, scope)) {
      const { node } = outNode(href, `${c.name || href} (out of scope)`);
      g.data.meta.links[href] = node.id;
      return { node, kind: "navigation", element, outcome: "out-of-scope" };
    }
    const b = admitUrl(href);
    if (!b.ok) {
      const { node } = g.addNode({ url: href, signature: ["bounded"], bound: b.bound, label: `${new URL(href).pathname} (bounded)` });
      return { node, kind: "navigation", element, outcome: "bounded" };
    }
    try {
      await load(side, c.href);
    } catch (e) {
      if (!(e instanceof TransientError)) throw e;
      // Still failing after every retry: a gap with a retryable reason, never a node read off
      // an error page. `requeue --gaps` walks it again later.
      const { node, isNew } = g.addNode({ url: href, signature: ["unreachable"], label: `${c.name || new URL(href).pathname} (unreachable)` });
      if (isNew || node.status === "frontier") markGap(g, node.id, { code: "transient", retryable: true }, e.message);
      return { node, kind: "navigation", element, outcome: "unreachable" };
    }
    const onLoad = await dismissOnLoad(side, { onAct: () => acting(side) });
    const final = side.url();
    if (!inScope(final, scope)) {
      const { node } = outNode(final, `${c.name || final} (redirects out of scope)`);
      g.data.meta.links[href] = node.id;
      return { node, kind: "navigation", element, outcome: "redirect-out" };
    }
    const r = await side.evaluate(probe, {});
    const { node } = g.addNode({ url: final, signature: r.signature, modules: r.modules, interactive: r.candidates.length, label: r.heading || r.title || new URL(final).pathname });
    g.data.meta.links[href] = node.id;
    recordOnLoad(node, onLoad);
    return { node, kind: "navigation", element, outcome: "page" };
  }

  /** Mark what floats and the network counters, before an interaction. */
  async function begin(n, c) {
    await page.evaluate(markFloating, FLOATING_SEL);
    current = { node: n.id, element: `${c.role} "${String(c.name ?? "").slice(0, 60)}"` };
    g.signal("walker.at", { node: n.id, element: current.element });
    acting(page);
    return { blocked: net.blocked.length, reads: net.reads, popups: net.popups.length, dialogs: net.dialogs.length, downloads: net.downloads.length, failures: net.failures.length, refused: net.refused.length };
  }

  /**
   * Read what one interaction did, from the pre-state `before` (skeleton) and `urlBefore`, and
   * record it: a popup or navigation, a new overlay, an in-place state (the skeleton changed, an
   * aria-expanded opened, or `change.read()` differs from its value before the act: a form's
   * validation state, a drag's geometry), a native dialog or download, a write attempt, or
   * nothing (`inert`). `kind` is the edge kind when no write was sent; a write makes it `write`.
   */
  async function observe(n, c, { kind = "click", element, before, urlBefore, rawBefore, mark, loc, expandedBefore, out, change, changeBefore, stateKey }) {
    const link = (k, node, request = null) => {
      // A result an older graph recorded for this same control under a look-alike it was merged
      // into (same kind and skeleton family, another content key) is stale once the split is read.
      if (node.contentKey) {
        for (const e of [...(g.out.get(n.id) ?? [])]) {
          const t = g.data.nodes[e.to];
          if (e.to !== node.id && e.kind === k && e.element?.name === element.name && (e.element?.nth ?? 0) === (element.nth ?? 0) && t.kind === node.kind && t.template === node.template && t.contentKey && t.contentKey !== node.contentKey) g.removeEdge(e.id);
        }
      }
      const { edge } = g.addEdge({ from: n.id, to: node.id, kind: k, element, request, via: k === "write" && kind !== "click" ? kind : undefined });
      if (out.loadAborted) edge.loadAborted = out.loadAborted;
      out.children.push(node.id);
    };
    // A write the opened page sent while loading is aborted and queued, but it is the page's, not
    // this act's: the edge stays what the act was, so the page is reached by replay.
    const sent = net.blocked.slice(mark.blocked);
    const blocked = sent.filter((b) => b.phase !== "load");
    const atLoad = sent.filter((b) => b.phase === "load");
    if (atLoad.length) {
      pending(n, c, `the page this ${kind} opened sent a write while loading; it was aborted`, atLoad, "write");
      out.loadAborted = atLoad.map((b) => `${b.method} ${b.url}`);
    }
    const refused = net.refused.slice(mark.refused ?? net.refused.length);
    const reads = net.reads - mark.reads;
    const popups = net.popups.slice(mark.popups);
    const dialogs = net.dialogs.slice(mark.dialogs);
    const downloads = net.downloads.slice(mark.downloads);
    // Only a request classified as a write makes the edge a write; read POSTs and beacons do not.
    const viaWrite = blocked.length > 0;
    const request = viaWrite ? { method: blocked[0].method, url: blocked[0].url, why: blocked[0].why } : null;
    const kindOf = () => (viaWrite ? "write" : kind);
    if (viaWrite) pending(n, c, `a ${kind} sent a write; it was aborted, so what opened is the failure path`, blocked, "write");

    // A fragment-only change that rebuilt the page: this app routes by fragments, so from now on
    // a fragment is part of every node's identity (graph meta `hashRoutes`).
    const rawNow = page.url();
    if (!g.data.meta.hashRoutes && rawNow !== rawBefore && rawNow.split("#")[0] === rawBefore.split("#")[0] && g.canon(rawNow) === urlBefore) {
      if (similarity(before, await sigOf()) < SAME_STATE) g.data.meta.hashRoutes = true;
    }

    if (refused.length) {
      // It tried to open a never-open URL; the navigation was refused before it left.
      link("session-ending", endingNode(refused[0], `never-open: ${never.match(refused[0])?.pattern ?? refused[0]}`));
      out.outcome = "session-ending";
    } else if (popups.length) {
      for (const url of popups) {
        const r = await readLink(n, { ...c, href: url });
        link("navigation", r.node);
      }
      out.outcome = "popup";
    } else if (g.canon(page.url()) !== urlBefore) {
      const url = page.url();
      if (!inScope(url, scope)) {
        const { node } = outNode(url, `${c.name || url} (out of scope)`);
        link("navigation", node);
        out.outcome = "out-of-scope";
      } else {
        const b = admitUrl(url);
        if (!b.ok) {
          const { node } = g.addNode({ url, signature: ["bounded"], bound: b.bound, label: `${new URL(url).pathname} (bounded)` });
          link(kindOf(), node, request);
          out.outcome = "bounded";
        } else {
          const r = await page.evaluate(probe, {});
          const { node } = g.addNode({ url, signature: r.signature, modules: r.modules, interactive: r.candidates.length, label: r.heading || r.title || new URL(url).pathname });
          link(kindOf(), node, request);
          out.outcome = "navigation";
        }
      }
    } else {
      // A tooltip after a click is the pointer resting on something, not what the click opened.
      const ov = (await page.evaluate(newOverlays, FLOATING_SEL)).find((o) => o.role !== "tooltip");
      if (ov) {
        const { signature: sig, contentKey } = await readOf(ov.css);
        const okind = KIND_OF_ROLE[ov.role] ?? "overlay";
        const { node } = stateNode({ url: page.url(), state: `${okind}:${ov.name || c.name}`, signature: sig, contentKey, kind: okind, label: `${okind}: ${ov.name || c.name}` });
        link(kindOf(), node, request);
        out.outcome = "overlay";
      } else {
        const { signature: after, contentKey } = await readOf();
        const expandedAfter = loc ? await loc.getAttribute("aria-expanded").catch(() => null) : null;
        const changeAfter = change ? await change.read().catch(() => null) : null;
        const changed = change ? changeAfter !== changeBefore : false;
        if (changed) out.change = { before: changeBefore, after: changeAfter };
        const reshaped = similarity(before, after) < SAME_STATE;
        if (change && (changed || reshaped)) {
          // An interaction that reads its own state (a form's validation, a handle's geometry, the
          // text an upload shows): its result is named by the interaction (or by that state), never
          // merged by skeleton into another surface that happens to look alike.
          const { node } = g.addNode({ url: page.url(), state: change.key ? change.key(changeAfter) : stateKey, signature: after, contentKey, kind: "state", label: change.label });
          if (node.id !== n.id) {
            link(kindOf(), node, request);
            out.outcome = "state";
          }
        } else if (reshaped || (expandedBefore !== expandedAfter && expandedAfter === "true")) {
          const state = stateKey ?? `${c.role}:${c.name}`;
          const { node } = stateNode({ url: page.url(), state, signature: after, contentKey, kind: "state", label: `${kind === "click" ? "" : `${kind} `}${c.role}: ${c.name}` });
          if (node.id !== n.id) {
            link(kindOf(), node, request);
            out.outcome = "state";
          }
        }
        if (!out.children.length) {
          if (dialogs.length) out.outcome = `native-dialog: ${dialogs[0].slice(0, 80)}`;
          else if (downloads.length) out.outcome = `download: ${downloads[0]}`;
          else if (viaWrite) out.outcome = "write-attempt";
        }
      }
    }
    await page.evaluate(clearMarks).catch(() => {});
    const failed = net.failures.slice(mark.failures).map((f) => `${f.kind} ${f.detail}`);
    current = { node: n.id, element: null };
    return { ...out, blocked: blocked.map((b) => `${b.method} ${b.url}`), reads: reads || undefined, failed: failed.length ? failed : undefined };
  }

  /**
   * Fire one element from `n`, from the verified pre-state `pre`, and say what happened.
   * `ensure` re-verifies the pre-state between the hover and the click.
   */
  async function tryElement(n, c, pre, ensure) {
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth };
    const out = { outcome: "inert", children: [] };
    const loc = await locate(page, c);
    if (!loc) return unfired(out, "not-found");
    let before = pre.sig;
    const urlBefore = g.canon(page.url());
    const rawBefore = page.url();

    if (c.haspopup || c.inNav) {
      acting(page);
      await page.evaluate(markFloating, FLOATING_SEL);
      await loc.hover({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(350);
      const ov = (await page.evaluate(newOverlays, FLOATING_SEL))[0];
      if (ov) {
        const { signature: sig, contentKey } = await readOf(ov.css);
        const kind = KIND_OF_ROLE[ov.role] ?? "overlay";
        const { node } = stateNode({ url: page.url(), state: `${kind}:${ov.name || c.name}`, signature: sig, contentKey, kind, label: `${kind}: ${ov.name || c.name}` });
        g.addEdge({ from: n.id, to: node.id, kind: "hover", element });
        out.children.push(node.id);
        out.outcome = "hover-overlay";
      }
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
      await page.evaluate(clearMarks);
      // What the hover opened may still be open: the click fires from the pre-state too.
      const r = await ensure();
      if (!r.ok) return out.children.length ? out : unfired(out, "state-not-restored");
      before = r.pre.sig;
    }

    const mark = await begin(n, c);
    const expandedBefore = c.expanded;
    // A shared or rate-limited reference (a sandbox tenant other people use): space the clicks.
    if (pace) await page.waitForTimeout(pace);
    try {
      await (await locate(page, c) ?? loc).click({ timeout: 4000 });
    } catch (e) {
      await page.evaluate(clearMarks).catch(() => {});
      if (out.children.length) return { ...out, error: e.message.split("\n")[0] };
      return unfired(out, "unclickable", { error: e.message.split("\n")[0] });
    }
    await settle(page, 2500);
    // A click that lands on a sign-in page or a "session expired" notice: the login is gone.
    await checkPage(page, { byName: c.name });
    return observe(n, c, { kind: "click", element, before, urlBefore, rawBefore, mark, loc, expandedBefore, out });
  }

  /**
   * Fire one interaction of another kind (interactions.mjs): restore the node's pre-state,
   * act, observe. `change` reads a value whose change is a state even when the skeleton is the
   * same (`{ read, label }`); `stateKey` names that state.
   */
  async function fireAs(n, ensure, kind, c, { element, change = null, stateKey } = {}) {
    const out = { outcome: "inert", children: [] };
    const pre = await ensure();
    if (!pre.ok) return unfired(out, "state-not-restored");
    const loc = await locateFor(page, kind, element, locate).catch(() => null);
    if (!loc) return unfired(out, "not-found");
    const urlBefore = g.canon(page.url());
    const rawBefore = page.url();
    const changeBefore = change ? await change.read().catch(() => null) : null;
    const mark = await begin(n, c);
    if (pace) await page.waitForTimeout(pace);
    try {
      await perform(page, kind, element, loc, locate);
    } catch (e) {
      await page.evaluate(clearMarks).catch(() => {});
      return unfired(out, "unclickable", { error: e.message.split("\n")[0] });
    }
    await settle(page, 2500);
    await checkPage(page, { byName: c.name ?? "" });
    return observe(n, c, { kind, element, before: pre.pre.sig, urlBefore, rawBefore, mark, loc: kind === "click" ? loc : null, out, change, changeBefore, stateKey: stateKey ?? `${kind}:${c.role}:${c.name}` });
  }

  /**
   * The node's structural labels (qa/labels.mjs) at its capture width and every sweep width,
   * scoped to the overlay when it is one, then the viewport put back and the pre-state proven
   * (a resize can close a menu). Null when sweeping is off or the viewport cannot be read.
   */
  async function captureWidths(n, scopeCss) {
    if (!sweep.length) return null;
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null));
    if (!vp?.width) return null;
    const before = await preState();
    const out = { captured: vp.width, height: vp.height, scope: scopeCss, widths: {} };
    try {
      for (const w of [...new Set([vp.width, ...sweep])].sort((a, b) => a - b)) {
        await page.setViewportSize({ width: w, height: vp.height });
        await page.waitForTimeout(250);
        out.widths[w] = await page.evaluate(readLabels, { scopeCss }).catch(() => null);
      }
    } finally {
      await page.setViewportSize(vp).catch(() => {});
      await page.waitForTimeout(250);
    }
    if (!samePre(before, await preState())) await restore(n, before);
    return out;
  }

  /** The node's websocket calls, paired, written under `ws/`; returns the inventory rows. */
  function writeWs(art, frames) {
    const calls = pairFrames(frames);
    if (!calls.length) return [];
    mkdirSync(join(art, "ws"), { recursive: true });
    const parse = (d) => {
      if (d === null) return null;
      try {
        return JSON.parse(String(d).replace(/^\d+(?=[[{])/, ""));
      } catch {
        return d;
      }
    };
    return calls.map((c, i) => {
      const file = `${createHash("sha1").update(`${c.url} ${c.name} ${c.id ?? ""} ${i}`).digest("hex").slice(0, 12)}.json`;
      writeFileSync(join(art, "ws", file), JSON.stringify({ name: c.name, id: c.id, url: c.url, verdict: c.verdict, sent: parse(c.sent), received: parse(c.received) }, null, 1));
      return { name: c.name, id: c.id, url: c.url, verdict: c.verdict, answered: c.received !== null, file };
    });
  }

  async function expandNode(n) {
    net.bodies = [];
    net.ws = [];
    current = { node: n.id, element: "(load)" };
    g.signal("walker.at", { node: n.id, element: "(load)" });
    const loadMark = { blocked: net.blocked.length, failures: net.failures.length };
    const { scopeCss: fresh } = await reach(n);
    const scopeCss = fresh ?? n.info?.scope ?? null;
    const r = await page.evaluate(probe, { scopeCss });
    // Writes the page sent while loading were aborted. Queued like any write; and when the page
    // then shows nothing to fire or broke, the node is a retryable `load-aborted` gap, not a
    // surface read off a page the abort broke.
    const loadAborted = net.blocked.slice(loadMark.blocked).filter((b) => b.phase === "load");
    if (loadAborted.length) {
      g.annotate(n.id, { loadAborted: loadAborted.map((b) => `${b.method} ${b.url}`) });
      pending(n, { role: "page", name: "(page load)", css: null }, "the page sent a write while loading; it was aborted", loadAborted, "write");
      const broke = net.failures.slice(loadMark.failures).length > 0;
      if (!r.candidates.length || broke) throw new Error(`load-aborted: ${loadAborted.length} request(s) aborted while the page loaded (${loadAborted[0].method} ${new URL(loadAborted[0].url).pathname})${broke ? " and the page broke" : ", nothing to fire"}`);
    }
    // A placeholder (found bounded or unreachable) walked for real: read its skeleton now.
    // A node from an older graph (no content key) takes the key of what its route opens now.
    if (KEYED_KINDS.includes(n.kind) && !n.contentKey && r.contentKey) n.contentKey = r.contentKey;
    if (n.kind === "page" && n.signature?.length === 1 && ["bounded", "unreachable"].includes(n.signature[0])) g.reread(n.id, { signature: r.signature, modules: r.modules, label: r.heading || r.title || undefined });
    const bodies = (await Promise.all(net.bodies)).filter(Boolean);
    const frames = net.ws;
    net.bodies = null;
    net.ws = null;

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
      let reqFile;
      if (b.reqBody) {
        reqFile = file.replace(/\.json$/, ".req.json");
        writeFileSync(join(art, "xhr", reqFile), b.reqBody.slice(0, 2_000_000));
      }
      return { method: b.method, url: b.url, status: b.status, bytes: b.body.length, file, reqFile };
    });
    // What Phase D compares beyond pixels and the AX tree: the computed-style manifest and the
    // structural labels at every sweep width (verify's style and widths checks).
    const styles = await page.evaluate(styleManifest, { scopeCss }).catch(() => null);
    if (styles) writeFileSync(join(art, "styles.json"), JSON.stringify(styles));
    const labelsAt = await captureWidths(n, scopeCss);
    if (labelsAt) writeFileSync(join(art, "widths.json"), JSON.stringify(labelsAt));
    const wsReads = writeWs(art, frames);
    g.annotate(n.id, { title: r.title, heading: r.heading, interactive: r.candidates.length, artifacts: rel, scope: scopeCss, overflowX: r.overflowX, wsCalls: wsReads.length || undefined });
    g.rescope(n.id);

    // Outside the walk's scope (--scope, without --expand-out): recorded, not expanded. An entry
    // page is always expanded: it is where the in-scope pages are found.
    if (g.data.meta.walkScope && !g.inWalk(n) && !g.data.meta.walkScope.expandOut && !n.entry) {
      const rows = r.candidates.map((c) => unfired({ role: c.role, name: c.name, css: c.css, href: c.href }, "shallow"));
      writeFileSync(join(art, "inventory.json"), JSON.stringify({ id: n.id, url: n.url, state: n.state, kind: n.kind, title: r.title, requests, wsReads, candidates: rows, interactions: [], shallow: true, invariant: "ok" }, null, 1));
      g.annotate(n.id, { shallow: true, candidateKeys: [] });
      return rows;
    }

    // The Tab order (feeds verify's structure check), then the pre-state proven again.
    const beforeFocus = await preState();
    const focus = await focusOrder(page, scopeCss).catch(() => null);
    if (focus) writeFileSync(join(art, "focus.json"), JSON.stringify(focus));
    if (!samePre(beforeFocus, await preState())) await restore(n, beforeFocus);

    // A state or overlay re-exposes everything around it; only what is new to it is its own.
    const parentKeys = new Set();
    if (n.kind !== "page") {
      const path = g.route(n.id) ?? [];
      const parent = path.length ? g.data.nodes[path[path.length - 1].from] : null;
      for (const k of parent?.info?.candidateKeys ?? []) parentKeys.add(k);
      for (const k of parent?.info?.interactionKeys ?? []) parentKeys.add(k);
    }
    const keyOf = (c) => `${c.role}|${c.name}|${repeatGroup(c.css)}`;
    const groupSize = new Map();
    for (const c of r.candidates) if (!c.href) groupSize.set(repeatGroup(c.css), (groupSize.get(repeatGroup(c.css)) ?? 0) + 1);
    const groups = new Map();
    const outcomes = [];
    // The node's pre-state: every element fires from exactly this, verified each time.
    const base = await preState();
    const ensure = () => restore(n, base);

    // Template sampling: once two members of this template are closed, a member fires only
    // the controls no member has fired yet (names with their digits normalised). One listing's
    // calendar of 594 controls took four minutes; the next sixteen added nothing new.
    const tmpl = g.data.templates[n.template];
    const seenKeys = new Set(tmpl.seenKeys ?? []);
    const closedSiblings = tmpl.members.filter((id) => id !== n.id && ["closed", "built", "verified"].includes(g.data.nodes[id].status) && !g.data.nodes[id].info?.shallow).length;
    const templateSampled = closedSiblings >= TEMPLATE_SAMPLE;
    const normKey = (c) => `${c.role}|${c.name.replace(/\d+([.,]\d+)*/g, "#")}|${repeatGroup(c.css)}`;
    let skippedByTemplate = 0;

    for (const c of r.candidates) {
      const row = { role: c.role, name: c.name, css: c.css, href: c.href };
      if (templateSampled && seenKeys.has(normKey(c))) {
        skippedByTemplate++;
        outcomes.push(unfired(row, "template-seen"));
        continue;
      }
      seenKeys.add(normKey(c));
      if (parentKeys.has(keyOf(c))) {
        outcomes.push(unfired(row, "inherited"));
        continue;
      }
      if (c.disabled || c.field || c.options) {
        outcomes.push(unfired(row, c.disabled ? "disabled" : c.options ? "select" : "field", { options: c.options ?? undefined }));
        continue;
      }
      const safety = classify(c);
      // A money-word choice inside a picker is fired and judged by what it sent (below).
      if (safety.verdict === "never" || (safety.verdict === "risky" && risky !== "probe" && !safety.choice)) {
        pending(n, c, safety.why, [], "risky-name");
        outcomes.push(unfired(row, `skipped:${safety.verdict}`));
        continue;
      }

      const shellKey = `${keyOf(c)}`;
      const shell = g.data.meta.shellClicks[shellKey];
      if (!c.href && shell && shell.pages.length >= 2 && !shell.pages.includes(n.template)) {
        outcomes.push(unfired(row, `shell: expanded on ${shell.pages.length} templates`));
        continue;
      }

      const grp = repeatGroup(c.css);
      if (!c.href && (groupSize.get(grp) ?? 0) > STATE_BOUND) {
        const G = groups.get(grp) ?? { tried: 0, leads: new Set() };
        groups.set(grp, G);
        if ((G.tried >= sample && G.leads.size <= 1) || G.tried >= STATE_BOUND) {
          outcomes.push(unfired(row, "sampled-out"));
          continue;
        }
        G.tried++;
      }

      let res;
      try {
        if (c.href && !c.href.startsWith("javascript:") && g.canon(c.href) !== g.canon(page.url())) {
          const l = await readLink(n, c);
          g.addEdge({ from: n.id, to: l.node.id, kind: l.kind, element: l.element });
          res = { outcome: l.outcome, children: [l.node.id] };
        } else {
          // Never fire from a state the last element left behind: restore, verify, then fire.
          const pre = await ensure();
          if (!pre.ok) {
            outcomes.push(unfired(row, "state-not-restored"));
            continue;
          }
          res = await tryElement(n, c, pre.pre, ensure);
          // Gone after the restore (a re-render moved it): one more try from a fresh load.
          if (["not-found", "unclickable"].includes(res.unfired)) {
            await reach(n, { fresh: true });
            const again = await ensure();
            if (again.ok) res = await tryElement(n, c, again.pre, ensure);
          }
          // A write verb that sent nothing at all still needs its write path captured once. One
          // that sent only reads (an "Apply" that filters) is a read, not a pending write.
          if (safety.verdict === "write-verb" && !res.blocked?.length && !res.reads && !isUnfired(res))
            pending(n, c, `${safety.why}; the click sent no request (a next step, or client-side state)`, [], "write-verb");
          // The picker choice fired despite its name: reads only keep its edge; a write it sent was
          // aborted and queued by observe (edge kind write).
          if (safety.choice && !isUnfired(res)) res.riskyChoice = res.blocked?.length ? `sent a write (aborted, pending): ${safety.why}` : `reads only: ${safety.why}`;
        }
      } catch (e) {
        if (e instanceof SessionEnding) res = ended(n, c, e);
        else if (e instanceof SessionLost || BROWSER_GONE.test(e.message) || NETWORK_GONE.test(e.message)) throw e;
        else res = unfired({ children: [] }, "error", { error: e.message.split("\n")[0] });
      }
      const G = groups.get(grp);
      if (G) G.leads.add((res.children ?? []).map((id) => g.data.nodes[id]?.template).join(",") || res.outcome);
      if (!c.href) {
        const s = (g.data.meta.shellClicks[shellKey] ??= { pages: [] });
        if (!s.pages.includes(n.template)) s.pages.push(n.template);
      }
      outcomes.push({ ...row, ...res });
    }

    const sampled = [...groups].filter(([grp, G]) => G.tried < groupSize.get(grp)).map(([grp, G]) => ({ group: grp, of: groupSize.get(grp), tried: G.tried }));
    tmpl.seenKeys = [...seenKeys];

    // Every other interaction kind (interactions.mjs): right-click, double-click, keys, drags,
    // forms, uploads. Each target ends as one row, like a click.
    let inter = { rows: [], keys: [], forms: [], files: [], globalKeys: false };
    if (interactions) {
      const seenI = new Set(tmpl.seenInteractions ?? []);
      inter = await runInteractions({
        page, n, scopeCss, outcomes, inherited: parentKeys, seen: seenI, templateSampled, shortcuts, writesAllowed, risky, sample,
        pending: (node, c, why, blocked, kind) => pending(node, c, why, blocked, kind),
        fire: async (kind, c, o) => {
          try {
            return await fireAs(n, ensure, kind, c, o);
          } catch (e) {
            if (e instanceof SessionEnding) return ended(n, c, e);
            if (e instanceof SessionLost || BROWSER_GONE.test(e.message) || NETWORK_GONE.test(e.message)) throw e;
            return unfired({ children: [] }, "error", { error: e.message.split("\n")[0] });
          }
        },
        reset: async () => {
          await reach(n, { fresh: true }).catch(() => {});
        },
      });
      tmpl.seenInteractions = [...seenI];
    }
    g.annotate(n.id, { candidateKeys: r.candidates.map(keyOf), interactionKeys: inter.keys, sampled: sampled.length ? sampled : undefined, templateSeen: skippedByTemplate || undefined });
    const violations = [...nodeInvariant(r.candidates, outcomes), ...interactionInvariant(inter.rows, knownUnfired)];
    const unfiredCount = outcomes.filter(isUnfired).length;
    writeFileSync(join(art, "inventory.json"), JSON.stringify({ id: n.id, url: n.url, state: n.state, kind: n.kind, title: r.title, requests, wsReads, candidates: outcomes, interactions: inter.rows, forms: inter.forms, files: inter.files, globalKeys: inter.globalKeys, invariant: violations.length ? violations : "ok" }, null, 1));
    if (violations.length) throw new InvariantError(`invariant: ${violations.length} element(s) unaccounted: ${violations.slice(0, 3).join("; ")}`);
    g.annotate(n.id, { unfired: unfiredCount || undefined, notRestored: outcomes.filter((o) => o.unfired === "state-not-restored").length || undefined });
    return outcomes;
  }

  // Entry pages seeded from a file (`--entries-from`): read, added as entries, walked first.
  for (const url of entries) {
    if (entryUrls().has(g.canon(url))) continue;
    try {
      await load(page, url);
      const onLoad = await dismissOnLoad(page, { onAct: () => acting(page) });
      const r = await page.evaluate(probe, {});
      const { node } = g.addNode({ url: page.url(), signature: r.signature, modules: r.modules, interactive: r.candidates.length, entry: true, label: r.heading || r.title || new URL(page.url()).pathname });
      g.markEntry(node.id);
      recordOnLoad(node, onLoad);
    } catch (e) {
      if (e instanceof SessionLost || BROWSER_GONE.test(e.message)) throw e;
      log(`entry ${url} not read: ${e.message.split("\n")[0]}`);
    }
  }
  save(g, dir);

  let done = 0;
  let netDown = 0;
  g.signal("walker.start", { area: onlyPrefix, frontier: g.frontier.size });
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
      // Never opened again once it signed the session out, nor anything reached through it.
      const barred = never.match(n.href ?? n.url);
      if (barred) {
        markGap(g, n.id, { code: "session-ending", retryable: false }, `never-open: ${barred.pattern}`);
        save(g, dir);
        continue;
      }
      // Reached only through a write (aborted while walking the reference): not replayable, and
      // not a failure. Closed as bounded; its write waits in pending-writes.jsonl for BLOCKED.
      // When every such write was a page-load request (an older rule aborted it), it is a
      // retryable `load-aborted` gap instead: `requeue --gaps` drops those edges and re-walks.
      if (g.route(n.id) === null) {
        const writesIn = Object.values(g.data.edges).filter((e) => e.to === n.id && e.kind === "write");
        const atLoad = (e) => e.loadAborted || (e.request?.url && reqs.classify({ method: e.request.method ?? "POST", url: e.request.url, phase: "load" }).verdict !== "write");
        if (writesIn.length && writesIn.every(atLoad)) {
          markGap(g, n.id, { code: "load-aborted", retryable: true }, "load-aborted: reached only through edges whose writes were page-load requests");
          save(g, dir);
          continue;
        }
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
        if (e instanceof SessionEnding) {
          // Reaching this node signed the session out: the URL it opened is never opened again.
          endingNode(e.target, e.message);
          if (n.status !== "gap") g.setStatus(n.id, "frontier");
          if (e.alive) {
            log(`session-ending ${e.target}: never opened again; the login survived, walk goes on`);
            save(g, dir);
            continue;
          }
          g.signal("walker.blocked", { node: n.id, reason: `${e.message.split("\n")[0]}; log in again` });
          save(g, dir);
          throw e;
        }
        if (e instanceof SessionLost) {
          g.signal("walker.blocked", { node: n.id, reason: `login lost: ${e.message.split("\n")[0]}` });
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
          g.signal("walker.blocked", { node: n.id, reason: `network down (${netDown}), retrying in 30 s` });
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
        const reason = failureReason(e.message);
        // A transient error already had its retries inside the load; anything else gets a
        // second whole try. Either way the gap says why, so `requeue --gaps` can take it back.
        if (e instanceof TransientError || e instanceof NeverOpenError || ["load-aborted", "never-open"].includes(reason.code) || n.attempts >= 2) markGap(g, n.id, reason, e.message);
        else g.setStatus(n.id, "frontier");
        log(`failed ${n.id} ${n.label.slice(0, 60)} [${reason.code}]: ${e.message.split("\n")[0]}`);
        g.signal("walker.error", { node: n.id, element: current.element, kind: reason.code, detail: e.message.split("\n")[0].slice(0, 300) });
      }
      save(g, dir);
      done++;
    }
  } finally {
    g.signal("walker.done", { stopped: stopping, frontier: g.frontier.size });
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

/**
 * Entry URLs from a file (`--entries-from`): one URL or path per line (`#` comments), or JSON: a
 * list of URLs, paths or `{ url | href | path | route }` objects, or a route map object whose
 * values (or keys) are paths. Paths resolve against `origin`.
 */
export function readEntriesFile(text, origin) {
  const abs = (s) => {
    try {
      return new URL(String(s).trim(), origin).toString();
    } catch {
      return null;
    }
  };
  let items;
  try {
    const doc = JSON.parse(text);
    const pick = (x) => (typeof x === "string" ? x : x?.url ?? x?.href ?? x?.path ?? x?.route ?? null);
    if (Array.isArray(doc)) items = doc.map(pick);
    else if (doc && typeof doc === "object") {
      const vals = Object.values(doc).flat().map(pick).filter((v) => typeof v === "string" && /^(\/|https?:)/.test(v));
      items = vals.length ? vals : Object.keys(doc).filter((k) => k.startsWith("/"));
    } else items = [];
  } catch {
    items = text.split("\n").map((l) => l.replace(/#(?!\/|!\/).*$/, "").trim());
  }
  return [...new Set(items.filter(Boolean).map(abs).filter(Boolean))];
}

/** Read one URL as an entry node (used by `run.mjs init` and `run.mjs visit`). */
export async function readEntry(g, url, opts = {}) {
  // `opts.dir`: the graph dir, whose never-open.jsonl an entry is refused by too.
  const barred = opts.dir ? new NeverOpen(join(opts.dir, "never-open.jsonl")).match(url) : null;
  if (barred) throw new NeverOpenError(`never-open: ${url} matches ${barred.pattern} (it signed the session out once)`);
  const { context, close } = await openReference(opts);
  // Which elements listen for a right-click, a double-click, a drag or keys (interactions.mjs).
  await context.addInitScript({ content: LISTENER_HOOK });
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
