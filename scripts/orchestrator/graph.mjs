// The surface graph (reference/graph.md) as code. One Graph holds every node, edge, template
// and module archetype of a build; it is serialised whole to discovery/graph.json, and every
// mutation is also emitted as an event so the live view and the resume log can follow it.

import { createHash } from "node:crypto";

import { dijkstra, pathTo, similarity, stronglyConnected, topoOrder } from "./algorithms.mjs";
import { IndexedHeap } from "./heap.mjs";

export const SCHEMA_VERSION = 1;
export const TEMPLATE_THRESHOLD = 0.92;

/** A node's lifecycle. `expanding` is transient: a crash leaves it there, load() requeues it. */
export const STATUSES = ["frontier", "expanding", "closed", "built", "verified", "gap", "bounded"];
export const EDGE_KINDS = ["click", "hover", "keyboard", "scroll", "redirect", "navigation", "write", "contextmenu", "dblclick", "key", "drag", "input", "submit", "upload"];

/**
 * Replay cost per edge kind for shortest paths. A write is never part of a replay route:
 * reaching a state through someone else's write would dirty the reference.
 */
export const EDGE_COST = {
  redirect: 0, hover: 0.5, scroll: 0.5, click: 1, keyboard: 1, navigation: 1, write: Infinity,
  // interaction kinds the walker fires besides a click (interactions.mjs); each replays from its
  // edge's element (a right-click, a key, a drag offset, the synthetic values typed, a fixture file)
  contextmenu: 1, dblclick: 1, key: 1, drag: 1.5, input: 1, submit: 1, upload: 2,
};

// Tracking and cache-busting keys: a value that changes on every load must not make a new node.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref|ref_src|cmpid|cachebuster|cache_buster|_t|_ts|ts|timestamp|nocache|_)$/i;

/** A fragment that carries a route in a hash-routed app (`#/list/Kiosk`, `#!/home`). */
export const ROUTE_HASH = /^#!?\//;

/** Sorted query with tracking keys dropped (for the URL and for a route fragment's own query). */
const cleanQuery = (params) =>
  new URLSearchParams([...params].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();

/** A route fragment, canonical: its own query cleaned like the URL's, a trailing slash trimmed. */
function canonicalHash(hash) {
  const [path, query = ""] = hash.split(/\?(.*)/s);
  const q = cleanQuery(new URLSearchParams(query));
  const p = path.length > 2 ? path.replace(/\/+$/, "") : path;
  return `${p}${q ? `?${q}` : ""}`;
}

/**
 * Query keys sorted, tracking keys dropped, trailing slash trimmed. The fragment is dropped
 * unless it carries a route (`#/...`, `#!/...`), or `anyHash` is set: a graph that learned the
 * app routes by plain fragments (`meta.hashRoutes`, set by the walker when a fragment-only change
 * rebuilt the page). A hash-routed SPA's screens are separate nodes, not one.
 */
export function canonicalUrl(raw, { anyHash = false } = {}) {
  const u = new URL(raw);
  const hash = u.hash;
  u.search = cleanQuery(u.searchParams);
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  const keep = hash.length > 1 && (ROUTE_HASH.test(hash) || anyHash);
  return keep ? `${u.toString()}${canonicalHash(hash)}` : u.toString();
}

/** The route fragment of a URL, canonical, or "" (what bound.mjs and compare.mjs key families on). */
export function routeHash(raw, { anyHash = false } = {}) {
  try {
    const h = new URL(raw).hash;
    return h.length > 1 && (ROUTE_HASH.test(h) || anyHash) ? canonicalHash(h) : "";
  } catch {
    return "";
  }
}

export function nodeId(url, signature, state = "", opts = {}) {
  return "n_" + createHash("sha1").update(`${canonicalUrl(url, opts)}\n${state}\n${signature.join("\n")}`).digest("hex").slice(0, 12);
}

// ---------- gap reasons ----------

/**
 * Why a node is a gap, as text. The walker records `gapReason: { code, retryable, message }`
 * (explore.mjs `markGap`) and a line in `detail`; older graphs and `O gap --reason` have only
 * `detail`; a node added out of scope may carry only its placeholder signature.
 * `null` means no reason was recorded.
 */
export function gapReason(n) {
  const r = n.gapReason;
  if (r && typeof r === "object") return `${String(r.code ?? "gap").replace(/-/g, " ")}${r.message ? `: ${r.message}` : ""}`;
  if (r) return String(r);
  if (n.detail) return String(n.detail);
  if (n.signature?.length === 1 && n.signature[0] === "out-of-scope") return "out of scope";
  return null;
}

/**
 * Reasons that a retry cannot change: the surface is outside the target, a human ruled it out,
 * or reaching it costs money, a message or data. Everything else (a failed walk, a timeout, a
 * missing reason) is worth another pass. The walker's own `retryable` flag wins when recorded,
 * and run.mjs prefers the walker's exported rule over this fallback.
 */
export const NOT_RETRYABLE = /\b(out[ -]of[ -]scope|external|ruling|ruled|human|irreversible|metered|paid|billing|third[ -]party|session[- ]ending|never fire|by design|not in scope|disabled by (the )?reference|write[ -]only)\b/i;

export function isRetryableReason(reason, n) {
  if (typeof n?.gapReason?.retryable === "boolean") return n.gapReason.retryable;
  return !reason || !NOT_RETRYABLE.test(reason);
}

// ---------- scopes ----------

export const UNSCOPED = "unscoped";

/** A node is in `scope` when tagged with it; "unscoped" selects untagged nodes; no scope selects all. */
export function inScopeId(n, scope) {
  if (!scope) return true;
  return scope === UNSCOPED ? !n.scope : n.scope === scope;
}

/** A breadcrumb trail read from a saved AX tree (aria.yml): the names under a "breadcrumb" navigation. */
export function breadcrumbFromAria(aria) {
  const lines = (aria ?? "").split("\n");
  const i = lines.findIndex((l) => /^\s*- navigation "[^"]*breadcrumb[^"]*"/i.test(l));
  if (i < 0) return "";
  const indent = lines[i].search(/\S/);
  const names = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) <= indent) break;
    const m = /- (?:link|text|listitem)(?: "([^"]*)")?(?::\s*(.*))?$/.exec(l);
    const name = m?.[1] ?? m?.[2];
    if (name) names.push(name.trim());
  }
  return names.join(" > ");
}

const ruleRe = (v) => new RegExp(v, "i");

/** Does one rule match one node? Every field the rule names must match (AND). */
function ruleMatches(rule, n, fields) {
  const test = (key, value) => rule[key] === undefined || [rule[key]].flat().some((p) => ruleRe(p).test(value ?? ""));
  if (rule.kind !== undefined && ![rule.kind].flat().includes(n.kind)) return false;
  if (rule.template !== undefined && ![rule.template].flat().includes(n.template)) return false;
  const url = rule.url === undefined || [fields.path, fields.pathHash].filter((v) => v !== undefined).some((v) => [rule.url].flat().some((p) => ruleRe(p).test(v)));
  return url && test("title", fields.title) && test("heading", fields.heading) && test("breadcrumb", fields.breadcrumb) && test("label", n.label);
}

/** A node's path plus query, and the same with its fragment (a hash-routed app's route lives there). */
function pathFields(n) {
  try {
    const u = new URL(n.href ?? n.url);
    return { path: u.pathname + u.search, pathHash: u.hash ? u.pathname + u.search + u.hash : undefined };
  } catch {
    return { path: "" };
  }
}

/** The scope the first matching rule gives a node (url, label, kind, title and heading as known so far), or null. */
export function scopeByRules(rules, n) {
  const fields = { ...pathFields(n), title: n.info?.title, heading: n.info?.heading, breadcrumb: n.info?.breadcrumb };
  return (rules ?? []).find((r) => ruleMatches(r, n, fields))?.scope ?? null;
}

/**
 * Tag every node with a scope (a component id) from ordered rules; the first rule that
 * matches wins. A rule names any of `url` (regex on path + query), `title`, `heading`,
 * `breadcrumb`, `label` (regexes, case-insensitive), `kind` and `template` (ids); every field
 * it names must match. Then, unless `inherit: false`, an untagged node takes the scope of the
 * tagged members of its template (when they agree on one), and an untagged overlay or state
 * takes its parent's (the node its cheapest route opens it from), until nothing changes.
 * `extra(n)` supplies fields read off disk (the breadcrumb from aria.yml). Returns counts.
 */
export function tagScopes(g, map, extra = () => ({})) {
  const rules = map.rules ?? [];
  for (const r of rules) if (!r.scope) throw new Error(`scope rule without a scope: ${JSON.stringify(r)}`);
  const nodes = Object.values(g.data.nodes);
  for (const n of nodes) {
    const { path, pathHash } = pathFields(n);
    const ex = extra(n) ?? {};
    const fields = { path, pathHash, title: n.info?.title ?? ex.title, heading: n.info?.heading ?? ex.heading, breadcrumb: n.info?.breadcrumb ?? ex.breadcrumb };
    const hit = rules.find((r) => ruleMatches(r, n, fields));
    n.scope = hit ? hit.scope : null;
    n.scopeBy = hit ? `rule ${rules.indexOf(hit) + 1}` : null;
  }
  if (map.inherit !== false) {
    const routes = g.routes();
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of nodes) {
        if (n.scope) continue;
        const peers = new Set((g.data.templates[n.template]?.members ?? []).map((id) => g.data.nodes[id].scope).filter(Boolean));
        if (peers.size === 1) {
          [n.scope] = peers;
          n.scopeBy = "template";
          changed = true;
          continue;
        }
        if (n.kind === "page") continue;
        const path = routes[n.id]?.path ?? [];
        const parent = path.length ? g.data.nodes[g.data.edges[path[path.length - 1]].from] : null;
        if (parent?.scope) {
          n.scope = parent.scope;
          n.scopeBy = "parent";
          changed = true;
        }
      }
    }
  }
  const counts = {};
  for (const n of nodes) counts[n.scope ?? UNSCOPED] = (counts[n.scope ?? UNSCOPED] ?? 0) + 1;
  g.data.meta.scopes = { at: new Date().toISOString(), rules: rules.length, counts };
  return counts;
}

export class Graph {
  constructor(data) {
    this.data = data ?? { version: SCHEMA_VERSION, meta: {}, nodes: {}, edges: {}, templates: {}, modules: {}, shell: null };
    this.listeners = [];
    this.frontier = new IndexedHeap((a, b) => this.#compare(a, b));
    this.out = new Map();
    // JSON has no Infinity: an unreached depth and a write's cost come back as null.
    for (const e of Object.values(this.data.edges)) {
      e.cost = EDGE_COST[e.kind];
      this.#index(e);
    }
    for (const n of Object.values(this.data.nodes)) {
      if (n.depth === null) n.depth = Infinity;
      if (n.status === "expanding") n.status = "frontier";
      if (n.status === "frontier") this.frontier.push(n.id, n.id);
    }
  }

  static create(meta = {}) {
    return new Graph({ version: SCHEMA_VERSION, meta: { ...meta, created: new Date().toISOString() }, nodes: {}, edges: {}, templates: {}, modules: {}, shell: null });
  }

  on(fn) {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((f) => f !== fn));
  }

  #emit(type, payload) {
    const ev = { at: new Date().toISOString(), type, ...payload };
    for (const f of this.listeners) f(ev);
  }

  // ---------- nodes ----------

  /**
   * Add a discovered surface. `signature` is its tag-path skeleton; `modules` lists each
   * module's own skeleton so module archetypes cluster the same way templates do.
   * Returns `{ node, isNew }`; a node already in the graph is returned untouched (dedupe).
   */
  addNode({ url, signature, state = "", kind = "page", label, entry = false, interactive = 0, modules = [], inScope = true, bound }) {
    const canon = { anyHash: !!this.data.meta.hashRoutes };
    const id = nodeId(url, signature, state, canon);
    if (this.data.nodes[id]) return { node: this.data.nodes[id], isNew: false };
    const node = {
      id,
      url: canonicalUrl(url, canon),
      // The URL as found: canonicalising can change what a server answers (a trailing slash).
      href: url,
      state,
      kind,
      label: label ?? `${new URL(url).pathname}${state ? ` [${state}]` : ""}`,
      entry,
      depth: entry ? 0 : Infinity,
      interactive,
      signature,
      modules: modules.map((m) => this.#classifyModule(m)),
      template: null,
      status: !inScope ? "gap" : bound ? "bounded" : "frontier",
      bound: bound ?? null,
      discovered: new Date().toISOString(),
    };
    this.data.nodes[id] = node;
    node.template = this.#classify(node);
    if (this.data.meta.walkScope) node.walkScope = scopeByRules(this.data.meta.walkScope.rules, node);
    if (node.status === "frontier") this.frontier.push(id, id);
    this.#emit("node.added", { node: this.#public(node) });
    return { node, isNew: true };
  }

  node(id) {
    const n = this.data.nodes[id];
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  /**
   * A placeholder node (bounded or unreachable when found) read for real when it is walked: its
   * skeleton, modules and template replace the placeholder's, so it never samples as one template
   * with every other placeholder. The id stays, so its edges stay.
   */
  reread(id, { signature, modules = [], label }) {
    const n = this.node(id);
    const t = this.data.templates[n.template];
    if (t) t.members = t.members.filter((m) => m !== id);
    n.signature = signature;
    n.modules = modules.map((m) => this.#classifyModule(m));
    if (label) n.label = label;
    n.template = this.#classify(n);
    return n;
  }

  /** Make a known node an entry (`--entries-from`): depth 0, re-sifted, depths pushed downstream. */
  markEntry(id) {
    const n = this.node(id);
    if (n.entry) return n;
    n.entry = true;
    n.depth = 0;
    if (this.frontier.has(id)) this.frontier.update(id);
    this.#relax(id);
    return n;
  }

  /** Attach what a worker learned about a node (title, artifacts dir, overlay scope, bounds). */
  annotate(id, patch) {
    const n = this.node(id);
    n.info = { ...(n.info ?? {}), ...patch };
    this.#emit("node.info", { id, patch });
    return n;
  }

  /** This graph's canonical URL: route fragments kept, and any fragment once `meta.hashRoutes` is set. */
  canon(url) {
    return canonicalUrl(url, { anyHash: !!this.data.meta.hashRoutes });
  }

  // ---------- scope-driven walk ----------

  /**
   * `O explore --scope-map <json> --scope <ids>`: nodes whose scope (scope.json rules, the format
   * `tagScopes` reads) is one of `ids` outrank every other node in the queue; an overlay or state
   * with no rule of its own takes the scope of the node it was opened from. `expandOut` says
   * whether out-of-scope nodes are expanded (else the walker closes them shallowly).
   */
  setWalkScope({ rules = [], ids = [], expandOut = false } = {}) {
    this.data.meta.walkScope = ids.length ? { rules, ids, expandOut } : null;
    for (const id of Object.keys(this.data.nodes)) this.rescope(id);
  }

  /** Re-read one node's walk scope (after its title and heading are known); re-sift it if queued. */
  rescope(id) {
    const ws = this.data.meta.walkScope;
    const n = this.data.nodes[id];
    if (!ws || !n) return;
    const own = scopeByRules(ws.rules, n);
    const next = own ?? (n.walkScopeBy === "parent" ? n.walkScope : null);
    if (own) delete n.walkScopeBy;
    if (next !== n.walkScope) {
      n.walkScope = next;
      if (this.frontier.has(id)) this.frontier.update(id);
    }
  }

  /** In the walk's scope (always true when the walk has none). */
  inWalk(n) {
    const ws = this.data.meta.walkScope;
    return !ws || ws.ids.includes(n.walkScope);
  }

  /** Nodes on one canonical URL, to match a state against ones already seen there. */
  nodesAt(url) {
    const c = this.canon(url);
    return Object.values(this.data.nodes).filter((n) => n.url === c);
  }

  setStatus(id, status, detail) {
    if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
    const n = this.node(id);
    const from = n.status;
    n.status = status;
    if (detail !== undefined) n.detail = detail;
    if (status === "frontier") this.frontier.push(id, id);
    else this.frontier.delete(id);
    if (status === "built" && n.template) this.data.templates[n.template].built = true;
    this.#emit("node.status", { id, from, to: status, detail });
  }

  // ---------- edges ----------

  /**
   * Add an interaction. Deduped on (from, to, kind, element name); updates depth and in-degree.
   * `via` is the interaction a `write` edge was fired by when it was not a click (a submit, a drag).
   */
  addEdge({ from, to, kind, element = {}, request = null, reversible = kind !== "write", via }) {
    if (!EDGE_KINDS.includes(kind)) throw new Error(`bad edge kind ${kind}`);
    this.node(from);
    this.node(to);
    const id = "e_" + createHash("sha1").update(`${from}|${to}|${kind}|${element.name ?? element.selector ?? ""}`).digest("hex").slice(0, 12);
    if (this.data.edges[id]) return { edge: this.data.edges[id], isNew: false };
    const edge = { id, from, to, kind, element, request, reversible, cost: EDGE_COST[kind], ...(via ? { via } : {}) };
    this.data.edges[id] = edge;
    this.#index(edge);
    const target = this.data.nodes[to];
    const src = this.data.nodes[from];
    if (this.data.meta.walkScope && target.kind !== "page" && !target.walkScope && src.walkScope) {
      target.walkScope = src.walkScope;
      target.walkScopeBy = "parent";
      if (this.frontier.has(to)) this.frontier.update(to);
    }
    if (kind !== "write") this.#relax(from);
    const t = this.data.templates[target.template];
    if (t) {
      t.inDegree++;
      for (const m of t.members) if (this.frontier.has(m)) this.frontier.update(m);
    }
    this.#emit("edge.added", { edge });
    return { edge, isNew: true };
  }

  /** Push a shorter hop depth downstream (BFS), re-sifting any frontier node it changes. */
  #relax(start) {
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      const d = this.data.nodes[u].depth + 1;
      for (const e of this.out.get(u) ?? []) {
        if (e.kind === "write") continue;
        const v = this.data.nodes[e.to];
        if (d < v.depth) {
          v.depth = d;
          if (this.frontier.has(v.id)) this.frontier.update(v.id);
          queue.push(v.id);
        }
      }
    }
  }

  #index(e) {
    if (!this.out.has(e.from)) this.out.set(e.from, []);
    this.out.get(e.from).push(e);
  }

  // ---------- templates & modules ----------

  #classify(node) {
    let best = null;
    let bestScore = 0;
    for (const t of Object.values(this.data.templates)) {
      const s = similarity(node.signature, t.signature);
      if (s > bestScore) [best, bestScore] = [t, s];
    }
    if (best && bestScore >= TEMPLATE_THRESHOLD) {
      best.members.push(node.id);
      return best.id;
    }
    const id = `t${Object.keys(this.data.templates).length + 1}`;
    this.data.templates[id] = { id, signature: node.signature, members: [node.id], inDegree: 0, built: false, component: null };
    this.#emit("template.added", { template: { id, first: node.id } });
    return id;
  }

  #classifyModule(sig) {
    for (const m of Object.values(this.data.modules)) {
      if (similarity(sig, m.signature) >= TEMPLATE_THRESHOLD) {
        m.uses++;
        return m.id;
      }
    }
    const id = `m${Object.keys(this.data.modules).length + 1}`;
    this.data.modules[id] = { id, signature: sig, uses: 1 };
    return id;
  }

  /**
   * The shell: module archetypes present on every in-scope page (overlays and bounded
   * placeholders excluded). Unknown
   * until two pages exist, since one page cannot tell its shell from its own modules; it only
   * ever shrinks as pages arrive.
   */
  shell() {
    const pages = Object.values(this.data.nodes).filter((n) => n.kind === "page" && n.status !== "gap" && n.status !== "bounded");
    if (pages.length < 2) return [];
    return [...pages.map((n) => new Set(n.modules)).reduce((a, b) => new Set([...a].filter((x) => b.has(x))))];
  }

  // ---------- the queue ----------

  /**
   * Frontier order (reference/graph.md "Priority"): with a walk scope, in-scope nodes first; nodes reached only through writes last;
   * entry nodes first; then the template with the most in-edges; then shallower; then the
   * one with fewer interactive elements (closes faster); id last so ties are stable.
   */
  #compare(a, b) {
    const x = this.data.nodes[a];
    const y = this.data.nodes[b];
    const k = (n) => [
      this.inWalk(n) || n.entry ? 0 : 1, // an entry page is where in-scope pages are found
      this.#writeOnly(n) ? 1 : 0,
      n.entry ? 0 : 1,
      -(this.data.templates[n.template]?.inDegree ?? 0),
      n.depth,
      n.interactive,
    ];
    const kx = k(x);
    const ky = k(y);
    for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] - ky[i];
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /** Not reachable from an entry without a write (or not linked yet). */
  #writeOnly(n) {
    return !n.entry && n.depth === Infinity;
  }

  /** Pop the next node to expand and mark it `expanding`. */
  next() {
    const id = this.frontier.pop();
    if (id === undefined) return null;
    this.setStatus(id, "expanding");
    return this.data.nodes[id];
  }

  frontierOrder() {
    return this.frontier.keys();
  }

  // ---------- algorithms ----------

  /** Cheapest replay route from any entry node to `target`, as a list of edges (writes excluded). */
  route(target, from) {
    const sources = from ? [from] : Object.values(this.data.nodes).filter((n) => n.entry).map((n) => n.id);
    const res = dijkstra(sources, (u) => (this.out.get(u) ?? []).map((e) => ({ to: e.to, cost: e.cost, edge: e })));
    return pathTo(res, target);
  }

  /** Every reachable node's replay route in one pass (for capture and golden traces). */
  routes() {
    const sources = Object.values(this.data.nodes).filter((n) => n.entry).map((n) => n.id);
    const res = dijkstra(sources, (u) => (this.out.get(u) ?? []).map((e) => ({ to: e.to, cost: e.cost, edge: e })));
    return Object.fromEntries([...res.dist.keys()].map((id) => [id, { cost: res.dist.get(id), path: pathTo(res, id).map((e) => e.id) }]));
  }

  /**
   * Build order over units: `shell`, each module archetype, each template. A module needs the
   * shell; a template needs the shell and every module it uses. Ties go to the unit the most
   * of the graph depends on, so shared work lands first.
   */
  buildOrder() {
    const shell = new Set(this.shell());
    const deps = new Map([["shell", []]]);
    for (const m of Object.keys(this.data.modules)) if (!shell.has(m)) deps.set(m, ["shell"]);
    for (const t of Object.values(this.data.templates)) {
      const used = new Set(t.members.flatMap((id) => this.data.nodes[id].modules).filter((m) => !shell.has(m)));
      deps.set(t.id, ["shell", ...used]);
    }
    const weight = (u) => (u === "shell" ? -Infinity : u.startsWith("m") ? -this.data.modules[u].uses : -this.data.templates[u].inDegree - this.data.templates[u].members.length);
    return topoOrder([...deps.keys()], deps, weight);
  }

  /** Groups of surfaces mutually reachable by navigation (loops); size-1 groups omitted. */
  loops() {
    const ids = Object.keys(this.data.nodes);
    return stronglyConnected(ids, (u) => (this.out.get(u) ?? []).filter((e) => e.kind !== "write").map((e) => e.to)).filter((c) => c.length > 1);
  }

  // ---------- state ----------

  /** reference/graph.md termination: frontier empty and nothing mid-expansion. */
  isClosed() {
    return this.frontier.size === 0 && !Object.values(this.data.nodes).some((n) => n.status === "expanding");
  }

  /** Counts for the whole graph, or for one scope (`O scope` tags; "unscoped" for untagged nodes). */
  stats(scope) {
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const nodes = Object.values(this.data.nodes).filter((n) => inScopeId(n, scope));
    for (const n of nodes) by[n.status]++;
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes: nodes.length,
      edges: Object.values(this.data.edges).filter((e) => ids.has(e.from) || ids.has(e.to)).length,
      templates: new Set(nodes.map((n) => n.template)).size,
      modules: scope ? new Set(nodes.flatMap((n) => n.modules)).size : Object.keys(this.data.modules).length,
      frontier: scope ? nodes.filter((n) => n.status === "frontier").length : this.frontier.size,
      byStatus: by,
      templateHistogram: Object.values(this.data.templates)
        .filter((t) => !scope || t.members.some((id) => ids.has(id)))
        .map((t) => ({ id: t.id, nodes: t.members.length, inDegree: t.inDegree, built: t.built })),
    };
  }

  // ---------- gaps ----------

  /**
   * Every gap node whose reason is retryable back on the frontier (attempts reset). `reason`
   * narrows it to gaps whose reason contains that text (case-insensitive); `retryable` decides
   * per reason (default `isRetryableReason`). Returns the requeued nodes.
   */
  requeueGaps({ reason, retryable = isRetryableReason } = {}) {
    const want = reason ? reason.toLowerCase() : null;
    const out = [];
    for (const n of Object.values(this.data.nodes)) {
      if (n.status !== "gap") continue;
      const r = gapReason(n);
      if (want && !(r ?? "").toLowerCase().includes(want)) continue;
      // A gap with no reason at all is retried: nothing says a retry cannot help.
      if (r !== null && !retryable(r, n)) continue;
      n.attempts = 0;
      delete n.gapReason;
      this.setStatus(n.id, "frontier", null);
      out.push(n);
    }
    return out;
  }

  #public(n) {
    return { id: n.id, url: n.url, label: n.label, kind: n.kind, status: n.status, template: n.template, depth: n.depth, entry: n.entry };
  }

  toJSON() {
    return this.data;
  }
}
