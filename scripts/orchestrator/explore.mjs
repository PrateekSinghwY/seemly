// The explore loop (orchestrator step 3): pop a node, reach it by its cheapest replay route,
// read it, fire every element once, record what each one opened, push the children, close the
// node, save. Repeats until the frontier is empty or the run's node budget is spent; a later
// run resumes from graph.json with nothing lost or repeated.
//
// Safety is in safety.mjs: names that end the session are never clicked, money/messaging/
// deletion names are queued for BLOCKED, and every non-read request (HTTP or websocket call) is
// aborted in the browser.
//
// Four invariants this file keeps, each with a test in test/walker.test.mjs:
//   - an element fires only from its node's verified pre-state, and what it opened is read
//     from the diff against that state (else it is `unfired: state-not-restored`, not an edge);
//   - an edge is a `write` only when a request it sent is a write, never a read POST;
//   - a lost login stops the run (SessionLost, exit 3) with the node back on the frontier, a
//     transient error is retried with backoff, and every gap carries a machine-readable reason;
//   - a node closes only when every element on it is an edge or a recorded reason.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { openReference, settle } from "../lib/pw.mjs";
import { similarity } from "./algorithms.mjs";
import { STATE_BOUND, admit, inScope, repeatGroup } from "./bound.mjs";
import { canonicalUrl } from "./graph.mjs";
import { FLOATING_SEL, clearMarks, markFloating, newOverlays, openFloating, openOnLoad, probe, sessionState } from "./page-probe.mjs";
import { RequestClassifier, classify, classifyFrame, pairFrames, parseFrame } from "./safety.mjs";
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
/** A navigation that kept failing transiently after every retry. */
export class TransientError extends Error {}
/** A node whose elements are not all accounted for: it must not close. */
export class InvariantError extends Error {}

/** Sign-in pages and identity hosts. `--login-pattern` overrides it for an unusual login URL. */
export const LOGIN_URL = /(^https?:\/\/(login|auth|sso|idp|signin|accounts)[.-])|\/(login|log-in|signin|sign-in|sign_in|logon|authn?|sso|saml2?|oauth2?|openid|adfs|cas|idp)(\/|\?|#|\.|$)/i;
const SIGN_IN_NAME = /\b(sign|log)\s*-?\s*in\b/i;
const TRANSIENT_ERR = /Timeout \d+ms exceeded|timed out|ERR_ABORTED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_HTTP2|ERR_SSL_PROTOCOL|HTTP (5\d\d|429|408)\b|serviceUnavailable|service unavailable/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- what every element ends as ----------

/** Fired, and opened something: the outcome carries `children`, one edge each. */
export const EDGE_OUTCOMES = new Set(["navigation", "page", "known", "out-of-scope", "redirect-out", "bounded", "popup", "overlay", "hover-overlay", "state", "unreachable"]);
/** Fired, and the result is recorded without an edge. */
export const FIRED_OUTCOMES = new Set(["inert", "write-attempt"]);
const FIRED_PREFIX = /^(native-dialog|download): /;
/** Not fired, with the reason it was not. */
export const UNFIRED_REASONS = new Set([
  "disabled", "field", "select", "skipped:never", "skipped:risky", "inherited", "template-seen", "sampled-out",
  "state-not-restored", "not-found", "unclickable", "error",
]);
const UNFIRED_PREFIX = /^shell: /;

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

// ---------- gaps: why a node was given up on ----------

/**
 * A machine-readable reason for an explore failure: `{ code, retryable }`. Retryable gaps are
 * what `requeue --gaps` puts back on the frontier.
 */
export function failureReason(message = "") {
  const m = String(message);
  if (/^HTTP 40[13]\b/.test(m)) return { code: "http-auth", retryable: true };
  if (/^HTTP 4\d\d\b/.test(m)) return { code: "http-4xx", retryable: false };
  if (TRANSIENT_ERR.test(m) && !/^replay:|locator\./.test(m)) return { code: "transient", retryable: true };
  if (/^replay: .* not found/.test(m)) return { code: "replay-not-found", retryable: true };
  if (/locator\.\w+: Timeout/.test(m)) return { code: "replay-timeout", retryable: true };
  if (/^invariant:/.test(m)) return { code: "invariant", retryable: true };
  if (/unreachable without a write/.test(m)) return { code: "write-only", retryable: false };
  return { code: "error", retryable: true };
}

/** Record `id` as a gap with its reason, on the node (`gapReason`) and in its status detail. */
export function markGap(g, id, reason, message) {
  const n = g.node(id);
  n.gapReason = { ...reason, message: String(message ?? "").split("\n")[0].slice(0, 300), at: new Date().toISOString() };
  g.setStatus(id, "gap", `explore failed (${reason.code}): ${n.gapReason.message}`);
}

/**
 * The reason of any gap node, including ones written before reasons existed (an out-of-scope
 * node, a legacy "explore failed twice: ..." detail, a person's `gap --reason`).
 */
export function gapReason(n) {
  if (n.status !== "gap") return null;
  if (n.gapReason) return n.gapReason;
  if (n.signature?.[0] === "out-of-scope") return { code: "out-of-scope", retryable: false, message: n.url };
  const d = n.detail ?? "";
  const m = d.match(/^explore failed[^:]*: (.*)$/s);
  if (m) return { ...failureReason(m[1]), message: m[1] };
  return { code: "manual", retryable: false, message: d };
}

/** Gap nodes whose reason is retryable: what `requeue --gaps` puts back. */
export function retryableGaps(g) {
  return Object.values(g.data.nodes).filter((n) => gapReason(n)?.retryable).map((n) => n.id);
}

/** Put every retryable gap back on the frontier with its attempts reset. Returns the ids. */
export function requeueGaps(g) {
  const ids = retryableGaps(g);
  for (const id of ids) {
    const n = g.node(id);
    n.attempts = 0;
    delete n.gapReason;
    g.setStatus(id, "frontier", null);
  }
  return ids;
}

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

/**
 * Options beyond the original ones (the CLI flag each one needs is in parentheses):
 *   retries      tries of a navigation that met a transient error (`--retries N`, default 3)
 *   backoffMs    first wait between them, doubling (`--backoff-ms N`, default 1500)
 *   loginPattern regex source for sign-in URLs (`--login-pattern <regex>`)
 *   wsGuard      "block" (default): websocket calls that are not reads are dropped in the
 *                browser; "off": frames are only recorded (`--ws-guard block|off`)
 */
export async function explore(g, dir, opts = {}) {
  const {
    maxNodes = Infinity, risky = "record", allowPost = [], readPosts = "off", pace = 0, sample = SAMPLE, onlyPrefix = null,
    retries = RETRIES, backoffMs = BACKOFF_MS, loginPattern = null, wsGuard = "block", log = (s) => console.error(s),
  } = opts;
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
  const reqs = new RequestClassifier({ allowPost, readPosts, onLearn: (row) => appendFileSync(allowedPath, JSON.stringify({ ...row, node: current.node, element: current.element }) + "\n") });
  if (existsSync(allowedPath)) reqs.load(readFileSync(allowedPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }));

  const { context, close } = await openReference(opts);
  const net = { blocked: [], reads: 0, popups: [], dialogs: [], downloads: [], bodies: null, ws: null, failures: [] };
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
    const v = reqs.classify({ method: req.method(), url: req.url(), postData: req.postData() });
    if (v.verdict === "write") {
      net.blocked.push({ method: req.method(), url: req.url(), body: (req.postData() ?? "").slice(0, 2000), why: v.why });
      return route.abort("blockedbyclient");
    }
    // Analytics beacons: not sent (they record the walk as usage), not a write either.
    if (v.verdict === "telemetry") return route.abort("blockedbyclient");
    // A non-read method let through as a read: logged, so a person can confirm each one is.
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method().toUpperCase())) {
      net.reads++;
      appendFileSync(allowedPath, JSON.stringify({ method: req.method(), url: req.url(), why: v.why, node: current.node, element: current.element }) + "\n");
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

  // ---------- session and transient errors, on every navigation ----------

  /**
   * Read where `p` is. Throws SessionLost on a sign-in page or a session-ended notice, unless
   * the navigation asked for a sign-in page itself (a "Log in" link on a public page). Returns
   * "transient" for an error page worth retrying.
   */
  async function checkPage(p, { requested = null, byName = "" } = {}) {
    const st = await p.evaluate(sessionState, { loginSrc: loginRe.source }).catch(() => null);
    if (!st) return null;
    if (st.transient) return { transient: true, login: st.login, why: st.why, href: st.href };
    const askedForLogin = (requested && loginRe.test(requested)) || SIGN_IN_NAME.test(byName);
    if ((st.login || st.ended) && !askedForLogin) throw new SessionLost(`${st.why} at ${st.href}`);
    return null;
  }

  /**
   * Navigate `p` to `url` and settle, retrying transient failures (5xx, a "service unavailable"
   * page, a timeout, an aborted load) with doubling backoff. `fresh` forces a real load when the
   * page is already on that URL (a hash route would otherwise not reload). Returns the response.
   */
  async function load(p, url, { fresh = false } = {}) {
    let last = "";
    let onLogin = false;
    for (let i = 0; i <= retries; i++) {
      if (i) await sleep(backoffMs * 2 ** (i - 1));
      try {
        if (fresh || i) await p.goto("about:blank").catch(() => {});
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
    const l = await locate(page, el);
    if (!l) throw new Error(`replay: "${el.name || el.css}" not found`);
    if (kind === "hover") await l.hover({ timeout: 4000 });
    else await l.click({ timeout: 4000 });
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

  async function readLink(n, c) {
    const href = canonicalUrl(c.href);
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth, href };
    const known = g.data.meta.links[href];
    if (known && g.data.nodes[known]) return { node: g.data.nodes[known], kind: "navigation", element, outcome: "known" };
    if (!inScope(href, scope)) {
      const { node } = outNode(href, `${c.name || href} (out of scope)`);
      g.data.meta.links[href] = node.id;
      return { node, kind: "navigation", element, outcome: "out-of-scope" };
    }
    const b = admit(g.data.meta.bounds, href);
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
    const onLoad = await dismissOnLoad(side);
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

  /**
   * Fire one element from `n`, from the verified pre-state `pre`, and say what happened.
   * `ensure` re-verifies the pre-state between the hover and the click.
   */
  async function tryElement(n, c, pre, ensure) {
    const element = { role: c.role, name: c.name, css: c.css, nth: c.nth };
    const out = { outcome: "inert", children: [] };
    const link = (kind, node, request = null) => {
      g.addEdge({ from: n.id, to: node.id, kind, element, request });
      out.children.push(node.id);
    };
    const loc = await locate(page, c);
    if (!loc) return unfired(out, "not-found");
    let before = pre.sig;
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
      // What the hover opened may still be open: the click fires from the pre-state too.
      const r = await ensure();
      if (!r.ok) return out.children.length ? out : unfired(out, "state-not-restored");
      before = r.pre.sig;
    }

    await page.evaluate(markFloating, FLOATING_SEL);
    const mark = { blocked: net.blocked.length, reads: net.reads, popups: net.popups.length, dialogs: net.dialogs.length, downloads: net.downloads.length, failures: net.failures.length };
    current = { node: n.id, element: `${c.role} "${c.name.slice(0, 60)}"` };
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
    const blocked = net.blocked.slice(mark.blocked);
    const reads = net.reads - mark.reads;
    const popups = net.popups.slice(mark.popups);
    const dialogs = net.dialogs.slice(mark.dialogs);
    const downloads = net.downloads.slice(mark.downloads);
    // Only a request classified as a write makes the edge a write; read POSTs and beacons do not.
    const viaWrite = blocked.length > 0;
    const request = viaWrite ? { method: blocked[0].method, url: blocked[0].url, why: blocked[0].why } : null;
    const kindOf = () => (viaWrite ? "write" : "click");
    if (viaWrite) pending(n, c, "a click sent a write; it was aborted, so what opened is the failure path", blocked, "write");

    if (popups.length) {
      for (const url of popups) {
        const r = await readLink(n, { ...c, href: url });
        link("navigation", r.node);
      }
      out.outcome = "popup";
    } else if (canonicalUrl(page.url()) !== urlBefore) {
      const url = page.url();
      if (!inScope(url, scope)) {
        const { node } = outNode(url, `${c.name || url} (out of scope)`);
        link("navigation", node);
        out.outcome = "out-of-scope";
      } else {
        const b = admit(g.data.meta.bounds, url);
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
        const sig = await sigOf(ov.css);
        const kind = KIND_OF_ROLE[ov.role] ?? "overlay";
        const { node } = stateNode({ url: page.url(), state: `${kind}:${ov.name || c.name}`, signature: sig, kind, label: `${kind}: ${ov.name || c.name}` });
        link(kindOf(), node, request);
        out.outcome = "overlay";
      } else {
        const after = await sigOf();
        const expandedAfter = await loc.getAttribute("aria-expanded").catch(() => null);
        if (similarity(before, after) < SAME_STATE || (expandedBefore !== expandedAfter && expandedAfter === "true")) {
          const { node } = stateNode({ url: page.url(), state: `${c.role}:${c.name}`, signature: after, kind: "state", label: `${c.role}: ${c.name}` });
          if (node.id !== n.id) {
            link(kindOf(), node, request);
            out.outcome = "state";
          }
        } else if (dialogs.length) out.outcome = `native-dialog: ${dialogs[0].slice(0, 80)}`;
        else if (downloads.length) out.outcome = `download: ${downloads[0]}`;
        else if (viaWrite) out.outcome = "write-attempt";
      }
    }
    await page.evaluate(clearMarks).catch(() => {});
    const failed = net.failures.slice(mark.failures).map((f) => `${f.kind} ${f.detail}`);
    current = { node: n.id, element: null };
    return { ...out, blocked: blocked.map((b) => `${b.method} ${b.url}`), reads: reads || undefined, failed: failed.length ? failed : undefined };
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
    const { scopeCss: fresh } = await reach(n);
    const scopeCss = fresh ?? n.info?.scope ?? null;
    const r = await page.evaluate(probe, { scopeCss });
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
    const wsReads = writeWs(art, frames);
    g.annotate(n.id, { title: r.title, heading: r.heading, interactive: r.candidates.length, artifacts: rel, scope: scopeCss, overflowX: r.overflowX, wsCalls: wsReads.length || undefined });

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
    // The node's pre-state: every element fires from exactly this, verified each time.
    const base = await preState();
    const ensure = () => restore(n, base);

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
      if (safety.verdict === "never" || (safety.verdict === "risky" && risky !== "probe")) {
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
        if (c.href && !c.href.startsWith("javascript:") && canonicalUrl(c.href) !== canonicalUrl(page.url())) {
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
        }
      } catch (e) {
        if (e instanceof SessionLost || BROWSER_GONE.test(e.message) || NETWORK_GONE.test(e.message)) throw e;
        res = unfired({ children: [] }, "error", { error: e.message.split("\n")[0] });
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
    g.annotate(n.id, { candidateKeys: r.candidates.map(keyOf), sampled: sampled.length ? sampled : undefined, templateSeen: skippedByTemplate || undefined });
    const violations = nodeInvariant(r.candidates, outcomes);
    const unfiredCount = outcomes.filter(isUnfired).length;
    writeFileSync(join(art, "inventory.json"), JSON.stringify({ id: n.id, url: n.url, state: n.state, kind: n.kind, title: r.title, requests, wsReads, candidates: outcomes, invariant: violations.length ? violations : "ok" }, null, 1));
    if (violations.length) throw new InvariantError(`invariant: ${violations.length} element(s) unaccounted: ${violations.slice(0, 3).join("; ")}`);
    g.annotate(n.id, { unfired: unfiredCount || undefined, notRestored: outcomes.filter((o) => o.unfired === "state-not-restored").length || undefined });
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
        const reason = failureReason(e.message);
        // A transient error already had its retries inside the load; anything else gets a
        // second whole try. Either way the gap says why, so `requeue --gaps` can take it back.
        if (e instanceof TransientError || n.attempts >= 2) markGap(g, n.id, reason, e.message);
        else g.setStatus(n.id, "frontier");
        log(`failed ${n.id} ${n.label.slice(0, 60)} [${reason.code}]: ${e.message.split("\n")[0]}`);
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
