// What the explorer must not fire on the reference unattended (SKILL.md section 4: paid,
// sending, publishing, deleting or account-changing actions are never fired; the first write
// of each kind is a BLOCKED). Two layers, because either alone has let a write through:
//
//   1. by name: a control whose accessible name or href reads as one of those actions is not
//      clicked at all; it is queued in pending-writes.jsonl for the BLOCKED step.
//   2. by request: while exploring, every non-read request is aborted before it leaves the
//      browser, so a control with an innocent name that writes anyway shows its failure path
//      and is recorded, instead of changing the account.

/** Never clicked, in any mode: ends the session or leaves the account. */
export const NEVER = /\b(log\s*-?\s*out|sign\s*-?\s*out|logoff|delete (my |your )?account|close (my |your )?account|deactivate)\b/i;
const NEVER_HREF = /(log-?out|sign-?out|logoff|\/session\/destroy)/i;

const words = (list) => new RegExp(`\\b(${list.join("|")})\\b`, "i");

/**
 * Money, messages to other people, deletion: not clicked unless the run says `--risky probe`
 * (writes still aborted); otherwise queued for the BLOCKED step.
 */
export const RISKY = words([
  "delete", "remove", "discard", "destroy", "erase", "purge", "revoke", "disconnect", "unlink",
  "cancel (my |your |the )?(subscription|plan|account|order|booking)", "unsubscribe", "downgrade",
  "pay", "payment", "purchase", "buy", "checkout", "place order", "upgrade", "subscribe", "add card", "top up",
  "send", "publish", "invite", "transfer", "withdraw", "book now", "reserve",
  // metered: spends a credit or token the account holds, even when nothing is charged
  "credits?", "tokens?", "spend", "unlock", "redeem",
]);

/**
 * Ordinary form verbs. Clicked, because most of them open the next step (a confirm, a picker,
 * a validation message) and the request layer aborts the write itself, but recorded too so the
 * write path gets its BLOCKED capture.
 */
export const WRITE_VERB = words(["save", "apply", "submit", "confirm", "sync( now)?", "import", "upload", "reset", "restore", "generate", "archive", "share", "post", "push"]);

/** `{ verdict: "never" | "risky" | "write-verb" | "ok", why }` for one probed candidate. */
export function classify({ name = "", href = "" }) {
  if (NEVER.test(name) || (href && NEVER_HREF.test(href))) return { verdict: "never", why: "ends the session or the account" };
  if (RISKY.test(name)) return { verdict: "risky", why: `name reads as money, messaging or deletion: "${name.match(RISKY)[0]}"` };
  if (WRITE_VERB.test(name)) return { verdict: "write-verb", why: `name reads as a write: "${name.match(WRITE_VERB)[0]}"` };
  return { verdict: "ok", why: "" };
}

// ---------- requests: is what a click sent a read or a write? ----------
//
// One classifier decides both whether the browser may send a request and whether the edge
// that sent it is a `write`. A read POST that is aborted and counted as a write mislabels the
// edge (a search button recorded as a write) and floods pending-writes.jsonl with reads.

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Words that name a read: in a path segment, an action value, or an RPC name. */
export const READ_WORDS = new Set([
  "search", "list", "get", "query", "read", "reads", "multiread", "fetch", "preview", "count", "load", "filter", "find",
  "lookup", "retrieve", "goto", "refresh", "suggest", "autocomplete", "typeahead", "browse",
]);
/** Read words that are verbs, so they name a read in any segment, not only the last. */
const READ_VERBS = new Set(["search", "get", "query", "read", "multiread", "fetch", "preview", "load", "find", "lookup", "retrieve", "goto"]);
/** Read verbs glued to a noun without a separator (`gotoconfig`, `getusers`): matched as a prefix. */
const READ_PREFIX = ["goto", "get", "fetch", "search", "query", "read", "load", "lookup"];
/** ... or as a suffix (`suitexsearch`, `multiread`). */
const READ_SUFFIX = ["search", "read", "reads", "query", "lookup"];
/** Words that name a change. Any one anywhere in a request makes it a write. */
export const WRITE_WORDS = new Set([
  "create", "add", "insert", "new", "update", "edit", "modify", "patch", "put", "set", "save", "delete", "remove", "destroy",
  "purge", "clear", "reset", "restore", "submit", "apply", "approve", "reject", "refuse", "sign", "signoff", "post", "commit",
  "import", "upload", "execute", "exec", "run", "send", "cancel", "publish", "unpublish", "lock", "unlock", "archive", "assign",
  "unassign", "invite", "transfer", "pay", "logout", "logoff", "signout", "login", "signin", "merge", "move", "copy", "rename",
  "enable", "disable", "toggle", "start", "stop", "trigger", "mark", "accept", "decline", "register", "subscribe", "unsubscribe",
  "follow", "unfollow", "like", "vote", "share", "close", "generate", "sync", "write", "store", "persist", "upsert", "replace",
  "change", "duplicate", "clone", "punch", "request", "order", "book", "reserve", "checkout", "purchase", "buy", "refund",
]);
/** Keys of a body that only shapes a read: paging, sorting, filtering, a date window. */
const QUERY_KEYS = new Set([
  "page", "pagesize", "pageindex", "pagenumber", "pagenum", "per", "perpage", "size", "offset", "limit", "top", "skip", "cursor",
  "after", "before", "sort", "sortby", "sortfield", "sortorder", "order", "orderby", "direction", "filter", "filters", "where",
  "query", "q", "search", "searchtext", "searchterm", "term", "keyword", "keywords", "criteria", "fields", "select", "columns",
  "include", "expand", "from", "to", "start", "end", "startdate", "enddate", "date", "dates", "daterange", "datespan", "span",
  "timeframe", "ids", "count", "status", "type", "types", "locale", "lang", "tz", "timezone", "view", "context", "scope",
]);
/** Analytics and logging beacons: never sent, never a write, never a pending row. */
const TELEMETRY = new Set(["telemetry", "analytics", "beacon", "beacons", "tracking", "track", "rum", "metrics", "collect", "clientlog", "clientlogs", "logging", "pixel", "sentry"]);

/** Lower-case words of a path segment, key or value: split on separators and camelCase. */
export function tokens(s) {
  return String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const hasWrite = (toks) => toks.find((t) => WRITE_WORDS.has(t));
const readWordIn = (toks, { verbsOnly = false } = {}) =>
  toks.find((t) => (verbsOnly ? READ_VERBS : READ_WORDS).has(t)) ??
  toks.find((t) => READ_PREFIX.some((w) => t.length > w.length + 2 && t.startsWith(w)) || READ_SUFFIX.some((w) => t.length > w.length + 2 && t.endsWith(w)));

/** Path segments with file extensions and api/version prefixes dropped. */
function segments(pathname) {
  return pathname.split("/").filter(Boolean).map((s) => s.replace(/\.(do|jsp|json|php|aspx?|action|html?)$/i, ""));
}

/** `/api/v1/users/42/search` -> `/api/v1/users/*\/search`: one rule for every id. */
export function pathTemplate(url) {
  const u = new URL(url);
  return u.pathname.split("/").map((s) => (/^\d+$|^[0-9a-f-]{16,}$|^[0-9a-f]{24,}$/i.test(s) ? "*" : s)).join("/");
}

/**
 * What a URL path, or an RPC name written like one, says it does: `read`, `write`, `telemetry`
 * or `unknown`. A write word anywhere wins, except a last segment that ends in read
 * (`apply_read`, `multi_read`), which names its result.
 */
export function nameVerdict(path) {
  const segs = segments(path);
  if (!segs.length) return { verdict: "unknown" };
  const last = segs[segs.length - 1];
  const lastToks = tokens(last);
  if (segs.some((s) => tokens(s).some((t) => TELEMETRY.has(t)))) return { verdict: "telemetry", why: "analytics or logging beacon" };
  if (/(^|[_-])(multi_?)?reads?$/i.test(last)) return { verdict: "read", why: `"${last}" names a read` };
  const w = segs.map((s) => hasWrite(tokens(s))).find(Boolean);
  if (w) return { verdict: "write", why: `"${w}" in the path` };
  const r = readWordIn(lastToks) ?? segs.slice(0, -1).map((s) => readWordIn(tokens(s), { verbsOnly: true })).find(Boolean);
  if (r) return { verdict: "read", why: `"${r}" in the path` };
  return { verdict: "unknown" };
}

/** The keys and action values of a JSON or form body. */
function bodyShape(postData) {
  const raw = (postData ?? "").trim();
  if (!raw) return { kind: "empty", keys: [], actions: [] };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const actions = ["action", "op", "operation", "operationName", "method", "command", "cmd", "name", "type"]
        .map((k) => j[k]).filter((v) => typeof v === "string");
      return { kind: "json", keys: Object.keys(j), actions, json: j };
    }
    return { kind: "json-array", keys: [], actions: Array.isArray(j) ? j.filter((v) => typeof v === "string") : [] };
  } catch {}
  if (/^[^=&\s]+=[^&]*(&|$)/.test(raw) || raw.startsWith("&")) {
    const p = new URLSearchParams(raw);
    const keys = [...new Set([...p.keys()])];
    const actions = [];
    for (const [k, v] of p) if (v && tokens(k).some((t) => ["action", "formaction", "op", "operation", "cmd", "command", "verb"].includes(t))) actions.push(v);
    return { kind: "form", keys, actions };
  }
  return { kind: "other", keys: [], actions: [] };
}

/**
 * What a body says it does. A GraphQL query or mutation decides; an action value (`ACTION=refresh`,
 * `formAction=...new`, `{"operation":"search"}`) decides; else a JSON body whose every key only
 * pages, sorts or filters is a read.
 */
export function bodyVerdict(postData) {
  const raw = (postData ?? "").trimStart();
  if (/\bmutation\b/.test(raw) && /"?query"?\s*:/.test(raw)) return { verdict: "write", why: "a GraphQL mutation" };
  if (/^\{?\s*"?query"?\s*:?\s*"?\s*(query\b|\{)/.test(raw)) return { verdict: "read", why: "a GraphQL query" };
  const b = bodyShape(postData);
  for (const a of b.actions) {
    const toks = tokens(a);
    const w = hasWrite(toks);
    if (w) return { verdict: "write", why: `action "${a.slice(0, 60)}" names "${w}"`, shape: b };
  }
  for (const a of b.actions) {
    const r = readWordIn(tokens(a));
    if (r) return { verdict: "read", why: `action "${a.slice(0, 60)}" names "${r}"`, shape: b };
  }
  if (b.kind === "json") {
    const keyToks = b.keys.map((k) => k.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const w = b.keys.map((k) => hasWrite(tokens(k))).find(Boolean);
    if (w) return { verdict: "write", why: `key names "${w}"`, shape: b };
    if (b.keys.length && keyToks.every((k) => QUERY_KEYS.has(k))) return { verdict: "read", why: `every key pages, sorts or filters (${b.keys.join(", ")})`, shape: b };
  }
  return { verdict: "unknown", shape: b };
}

/**
 * Decides, for every request a page sends while walking, `read` (let through), `write` (aborted,
 * the edge is a write, a pending row) or `telemetry` (aborted, not a write).
 *
 * `readPosts: "auto"` learns: a POST whose path or body reads as a read is let through, and the
 * rule it was let through by (method, path template, body shape) is appended once to
 * `rulesPath` (allowed-posts.jsonl) for a person to read. Rules in that file are loaded on the
 * next run. A write signal in the body still wins over a learned rule.
 */
export class RequestClassifier {
  constructor({ allowPost = [], readPosts = "off", rulesPath = null, onLearn = null } = {}) {
    this.allowPost = allowPost;
    this.readPosts = readPosts;
    this.rulesPath = rulesPath;
    this.onLearn = onLearn;
    this.rules = new Map();
  }

  /** Learned rules from an earlier run (rows of allowed-posts.jsonl with `rule`). */
  load(rows) {
    for (const r of rows) if (r?.rule) this.rules.set(r.rule, r);
    return this;
  }

  classify({ method, url, postData = "" }) {
    const m = method.toUpperCase();
    if (READ_METHODS.has(m)) return { verdict: "read", why: "read method" };
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return { verdict: "write", why: "unparseable url" };
    }
    if (this.allowPost.some((re) => re.test(url))) return { verdict: "read", why: "allow-post rule" };
    const byName = nameVerdict(pathname);
    if (byName.verdict === "telemetry") return byName;
    const byBody = bodyVerdict(postData);
    if (byBody.why === "a GraphQL query") return byBody;
    if (byBody.verdict === "write") return byBody;
    if (this.readPosts !== "auto" || m !== "POST") return { verdict: "write", why: `${m} with --read-posts ${this.readPosts}` };
    if (byName.verdict === "write") return byName;
    const template = pathTemplate(url);
    const b = byBody.shape;
    const shape = b?.kind === "json" ? b.keys.slice().sort().join(",") : b?.kind === "form" ? `form:${b.actions.join("|")}` : (b?.kind ?? "empty");
    const urlRule = `${m} ${template}`;
    const bodyRule = `${m} ${template} {${shape}}`;
    if (this.rules.has(urlRule)) return { verdict: "read", why: `learned rule ${urlRule}`, rule: urlRule };
    if (this.rules.has(bodyRule)) return { verdict: "read", why: `learned rule ${bodyRule}`, rule: bodyRule };
    if (byName.verdict === "read") return this.#learn(urlRule, "url", byName.why, url);
    if (byBody.verdict === "read") return this.#learn(bodyRule, "body", byBody.why, url);
    return { verdict: "write", why: "nothing names it a read" };
  }

  #learn(rule, learned, why, url) {
    const row = { rule, learned, why, example: url, at: new Date().toISOString() };
    this.rules.set(rule, row);
    this.onLearn?.(row);
    return { verdict: "read", why: `learned (${learned}): ${why}`, rule, learned: row };
  }
}

/**
 * Is this request a write the explorer must abort? Kept for callers that only need yes or no;
 * the explorer uses RequestClassifier, which also tells telemetry from writes.
 */
export function isWrite({ method, url, postData = "" }, allowPost = [], { readPosts = "off" } = {}) {
  return new RequestClassifier({ allowPost, readPosts }).classify({ method, url, postData }).verdict !== "read";
}

/** Back-compat: true when a POST's path alone names a read. */
export function readPostByName(url) {
  try {
    return nameVerdict(new URL(url).pathname).verdict === "read";
  } catch {
    return false;
  }
}

// ---------- websocket / RPC frames ----------

/**
 * One websocket frame as `{ name, id, payload }`, or null when it carries no call (a ping, an
 * ack, binary). Understands `{"name":"/x/get","args":..}`, JSON-RPC `{"method","params","id"}`,
 * `{"action"|"type"|"event"|"op"|"path"|"route": ..}` and socket.io `42["event",{..}]`.
 */
export function parseFrame(data) {
  if (typeof data !== "string") return null;
  const raw = data.replace(/^\d+(?=[[{])/, "");
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(j)) return typeof j[0] === "string" ? { name: j[0], id: null, payload: j[1] ?? null } : null;
  if (!j || typeof j !== "object") return null;
  const name = ["name", "method", "action", "type", "event", "op", "path", "route", "procedure", "channel", "topic"].map((k) => j[k]).find((v) => typeof v === "string" && v) ?? null;
  const id = j.id ?? j.requestId ?? j.reqId ?? j.correlationId ?? j.cid ?? j.seq ?? null;
  if (name === null && id === null) return null;
  return { name, id: id === null ? null : String(id), payload: j.args ?? j.params ?? j.data ?? j.payload ?? j.body ?? j.result ?? null };
}

/** A sent frame classified the same way as an HTTP request, by its name (and its args' shape). */
export function classifyFrame(frame, allowPost = []) {
  if (!frame?.name) return { verdict: "read", why: "no call name (ping, ack or reply)" };
  if (allowPost.some((re) => re.test(frame.name))) return { verdict: "read", why: "allow-post rule" };
  const v = nameVerdict(frame.name.includes("/") ? frame.name : `/${frame.name.replace(/[.:]/g, "/")}`);
  if (v.verdict !== "unknown") return v;
  const b = frame.payload && typeof frame.payload === "object" ? bodyVerdict(JSON.stringify(frame.payload)) : { verdict: "unknown" };
  if (b.verdict !== "unknown") return b;
  return { verdict: "write", why: "nothing names the call a read" };
}

/**
 * Pair sent frames with what came back: by id when both carry one, else by name, oldest first.
 * Returns `[{ name, id, sent, received }]`; a call with no answer has `received: null`.
 */
export function pairFrames(frames) {
  const calls = [];
  const byId = new Map();
  const byName = new Map();
  for (const f of frames) {
    const p = f.parsed;
    if (f.dir === "sent") {
      if (!p?.name) continue;
      const call = { name: p.name, id: p.id, url: f.url, sent: f.data, received: null, verdict: f.verdict };
      calls.push(call);
      if (p.id !== null) byId.set(p.id, call);
      (byName.get(p.name) ?? byName.set(p.name, []).get(p.name)).push(call);
    } else if (p) {
      let call = p.id !== null ? byId.get(p.id) : null;
      if (call) byId.delete(p.id);
      else if (p.name) {
        const q = byName.get(p.name) ?? [];
        call = q.find((c) => c.received === null);
      }
      if (call && call.received === null) call.received = f.data;
    }
  }
  return calls;
}
