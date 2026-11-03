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
export const EDGE_KINDS = ["click", "hover", "keyboard", "scroll", "redirect", "navigation", "write"];

/**
 * Replay cost per edge kind for shortest paths. A write is never part of a replay route:
 * reaching a state through someone else's write would dirty the reference.
 */
export const EDGE_COST = { redirect: 0, hover: 0.5, scroll: 0.5, click: 1, keyboard: 1, navigation: 1, write: Infinity };

// Tracking and cache-busting keys: a value that changes on every load must not make a new node.
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_ga|ref|ref_src|cmpid|cachebuster|cache_buster|_t|_ts|ts|timestamp|nocache|_)$/i;

/** Query keys sorted, tracking keys and the fragment dropped, trailing slash trimmed. */
export function canonicalUrl(raw) {
  const u = new URL(raw);
  const kept = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = new URLSearchParams(kept).toString();
  u.hash = "";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

export function nodeId(url, signature, state = "") {
  return "n_" + createHash("sha1").update(`${canonicalUrl(url)}\n${state}\n${signature.join("\n")}`).digest("hex").slice(0, 12);
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
    const id = nodeId(url, signature, state);
    if (this.data.nodes[id]) return { node: this.data.nodes[id], isNew: false };
    const node = {
      id,
      url: canonicalUrl(url),
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
    if (node.status === "frontier") this.frontier.push(id, id);
    this.#emit("node.added", { node: this.#public(node) });
    return { node, isNew: true };
  }

  node(id) {
    const n = this.data.nodes[id];
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  /** Attach what a worker learned about a node (title, artifacts dir, overlay scope, bounds). */
  annotate(id, patch) {
    const n = this.node(id);
    n.info = { ...(n.info ?? {}), ...patch };
    this.#emit("node.info", { id, patch });
    return n;
  }

  /** Nodes on one canonical URL, to match a state against ones already seen there. */
  nodesAt(url) {
    const c = canonicalUrl(url);
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

  /** Add an interaction. Deduped on (from, to, kind, element name); updates depth and in-degree. */
  addEdge({ from, to, kind, element = {}, request = null, reversible = kind !== "write" }) {
    if (!EDGE_KINDS.includes(kind)) throw new Error(`bad edge kind ${kind}`);
    this.node(from);
    this.node(to);
    const id = "e_" + createHash("sha1").update(`${from}|${to}|${kind}|${element.name ?? element.selector ?? ""}`).digest("hex").slice(0, 12);
    if (this.data.edges[id]) return { edge: this.data.edges[id], isNew: false };
    const edge = { id, from, to, kind, element, request, reversible, cost: EDGE_COST[kind] };
    this.data.edges[id] = edge;
    this.#index(edge);
    const target = this.data.nodes[to];
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
   * Frontier order (reference/graph.md "Priority"): nodes reached only through writes last;
   * entry nodes first; then the template with the most in-edges; then shallower; then the
   * one with fewer interactive elements (closes faster); id last so ties are stable.
   */
  #compare(a, b) {
    const x = this.data.nodes[a];
    const y = this.data.nodes[b];
    const k = (n) => [
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

  stats() {
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const n of Object.values(this.data.nodes)) by[n.status]++;
    return {
      nodes: Object.keys(this.data.nodes).length,
      edges: Object.keys(this.data.edges).length,
      templates: Object.keys(this.data.templates).length,
      modules: Object.keys(this.data.modules).length,
      frontier: this.frontier.size,
      byStatus: by,
      templateHistogram: Object.values(this.data.templates).map((t) => ({ id: t.id, nodes: t.members.length, inDegree: t.inDegree, built: t.built })),
    };
  }

  #public(n) {
    return { id: n.id, url: n.url, label: n.label, kind: n.kind, status: n.status, template: n.template, depth: n.depth, entry: n.entry };
  }

  toJSON() {
    return this.data;
  }
}
