// Pure graph algorithms over plain adjacency data. Nothing here knows about seemly's
// statuses or files; graph.mjs feeds it.

import { IndexedHeap } from "./heap.mjs";

/**
 * Weighted Jaccard over two multisets of DOM tag paths: sum(min) / sum(max) per path.
 * 1 = identical skeletons, 0 = nothing shared. Text and attribute values are already
 * stripped from the paths, so two leagues of one page type score ~1.
 */
export function similarity(a, b) {
  const ca = counts(a);
  const cb = counts(b);
  let min = 0;
  let max = 0;
  for (const k of new Set([...ca.keys(), ...cb.keys()])) {
    const x = ca.get(k) ?? 0;
    const y = cb.get(k) ?? 0;
    min += Math.min(x, y);
    max += Math.max(x, y);
  }
  return max === 0 ? 1 : min / max;
}

function counts(list) {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

/**
 * Multi-source Dijkstra. `edges(id)` yields `{ to, cost, edge }`; a cost of Infinity is never
 * traversed. Returns `dist` and `prev` (the edge that reached each node), so any node's
 * cheapest route from the nearest source is recoverable with `pathTo`.
 */
export function dijkstra(sources, edges) {
  const dist = new Map();
  const prev = new Map();
  const heap = new IndexedHeap((a, b) => a - b);
  for (const s of sources) {
    dist.set(s, 0);
    heap.push(s, 0);
  }
  const done = new Set();
  while (heap.size) {
    const u = heap.pop();
    done.add(u);
    for (const { to, cost, edge } of edges(u)) {
      if (!Number.isFinite(cost) || done.has(to)) continue;
      const d = dist.get(u) + cost;
      if (d < (dist.get(to) ?? Infinity)) {
        dist.set(to, d);
        prev.set(to, edge);
        heap.push(to, d);
      }
    }
  }
  return { dist, prev };
}

/** The edges from a source to `target` in order, or null when unreachable. */
export function pathTo(result, target, sourceOf = (e) => e.from) {
  if (!result.dist.has(target)) return null;
  const path = [];
  let cur = target;
  while (result.prev.has(cur)) {
    const e = result.prev.get(cur);
    path.unshift(e);
    cur = sourceOf(e);
  }
  return path;
}

/**
 * Kahn's topological sort. `deps` maps unit → units it needs built first. Ties break by
 * `rank` (lower first), so the order is deterministic. Throws with the cycle on a loop.
 */
export function topoOrder(units, deps, rank = () => 0) {
  const indeg = new Map(units.map((u) => [u, 0]));
  const users = new Map(units.map((u) => [u, []]));
  for (const u of units) {
    for (const d of deps.get(u) ?? []) {
      if (!indeg.has(d)) throw new Error(`unit ${u} depends on unknown unit ${d}`);
      indeg.set(u, indeg.get(u) + 1);
      users.get(d).push(u);
    }
  }
  const ready = new IndexedHeap((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [u, n] of indeg) if (n === 0) ready.push(u, [rank(u), u]);
  const order = [];
  while (ready.size) {
    const u = ready.pop();
    order.push(u);
    for (const v of users.get(u)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) ready.push(v, [rank(v), v]);
    }
  }
  if (order.length !== units.length) {
    const stuck = units.filter((u) => indeg.get(u) > 0);
    const cycle = stronglyConnected(stuck, (u) => (deps.get(u) ?? []).filter((d) => stuck.includes(d))).find((c) => c.length > 1) ?? stuck;
    throw new Error(`dependency cycle: ${cycle.join(" -> ")}`);
  }
  return order;
}

/** Tarjan's strongly connected components (iterative, so deep graphs cannot blow the stack). */
export function stronglyConnected(vertices, next) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const out = [];
  for (const root of vertices) {
    if (idx.has(root)) continue;
    const work = [[root, 0]];
    idx.set(root, index);
    low.set(root, index++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const succ = next(v);
      if (i < succ.length) {
        frame[1]++;
        const w = succ[i];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(v)));
      }
      if (low.get(v) === idx.get(v)) {
        const comp = [];
        let w;
        do {
          w = stack.pop();
          onStack.delete(w);
          comp.push(w);
        } while (w !== v);
        out.push(comp.reverse());
      }
    }
  }
  return out;
}
