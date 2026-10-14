# seemly orchestrator

`reference/graph.md` describes how seemly explores and builds an app as one graph. Until now
an agent carried that algorithm in its head. This folder turns it into code: a coordinator
owns the graph and decides what happens next, workers do one node each, and every change
is logged so a live view can draw the build as it grows.

Site-agnostic: nothing here names a target. A build's data lives in its own
`never_to_be_pushed/discovery/`.

## Build plan and status

| step | what | files | status |
|---|---|---|---|
| 0 | skill under git, baseline commit | `.gitignore` | done 2026-10-14 (local; remote pending) |
| 1 | graph engine: format, dedupe, templates, priority queue, shortest path, build order, loops | `heap.mjs` `algorithms.mjs` `graph.mjs` `store.mjs` `cli.mjs` | done 2026-10-14, 16 tests |
| L | learning engine: lesson store, escalation ladder, per-node lesson selection, eval runner, scorecard, fix-commit miner | `../../learning/` | done 2026-10-14, 11 tests; see `learning/README.md` |
| 2 | live diagram: artifact drawing the graph from `events.jsonl` | `live.mjs` + artifact | next |
| 3 | explore-only coordinator: pop, capture, inventory, push children, until closed | `run.mjs` + Workflow script | |
| 4 | build workers, one at a time in build order | `run.mjs` build phase | |
| 5 | `SKILL.md` drives the coordinator instead of prose | `SKILL.md`, `reference/graph.md` | |

## How it works

```
             entry URLs (INTAKE)
                    |
                    v
   +--------------- graph.json ----------------+        events.jsonl --> live diagram
   |  nodes   surfaces in a state               |              ^
   |  edges   click / hover / nav / write ...   |--- every ----+
   |  templates  nodes with one DOM skeleton    |   mutation
   |  modules    module archetypes              |
   +--------------------------------------------+
        |  next()                 ^  addNode / addEdge / setStatus
        v                         |
   coordinator  ---- one node --> worker (capture, inventory, expand, build, verify)
```

### 1. A node is a surface in a state

`node_id = sha1(canonical URL, state, DOM skeleton)`. The canonical URL drops tracking
params (`utm_*`, `gclid`, ...) and the fragment and sorts the query, so one surface reached
by two links is one node with two in-edges (**dedupe**). `addNode` returns `isNew: false`
for a surface already in the graph; the worker records the edge and moves on.

### 2. Templates: what is "the same page"

Each node's skeleton is a multiset of tag paths (text and attribute values stripped).
Similarity is **weighted Jaccard**: `sum(min counts) / sum(max counts)`. A node scoring
≥ 0.92 against an existing template joins it; otherwise it founds a new one. One template
= one page component; every later member is configuration rows, not code. Modules inside
pages cluster the same way into **module archetypes**.

The **shell** is the set of module archetypes on every in-scope page. It is unknown until
two pages exist (one page cannot tell its shell from its own modules) and only shrinks.

### 3. The frontier: what to explore next

An **indexed binary heap**. Order, first key that differs wins:

1. reachable without a write before only-through-a-write (writes last);
2. entry nodes first;
3. the template with the most in-edges (the most valuable to finish);
4. shallower (fewer hops from an entry);
5. fewer interactive elements (closes faster, unblocks children);
6. node id (stable ties).

Priorities move while nodes wait: a new edge raises its template's in-degree, a shorter
path lowers a node's depth. The heap's `update(key)` re-sifts that one entry in
O(log n) instead of rebuilding. Depth is kept exact by **BFS relaxation**: when a shorter
route appears, the new depth is pushed downstream.

`next()` pops a node and marks it `expanding`. If the run dies, loading `graph.json` puts
every `expanding` node back on the frontier, so a resume never loses or repeats work.

### 4. Shortest paths: how to get back to a deep state

**Dijkstra** from every entry node at once (multi-source). Edge costs: redirect 0,
hover/scroll 0.5, click/keyboard/navigation 1, **write ∞** (a replay must never fire a
write). `route(node)` returns the cheapest click sequence to reach a modal three levels
deep; capture and golden traces replay that instead of whatever path found it first.
`routes()` computes every node's route in one pass.

### 5. Build order: dependencies first

Units are `shell`, each module archetype, each template. A module needs the shell; a
template needs the shell and every module it uses. **Kahn's topological sort**, ties
broken by how much of the graph depends on the unit (most-used module first). A
dependency loop throws with the loop named, found by Tarjan below.

### 6. Loops

**Tarjan's strongly connected components** (iterative, so a deep graph cannot overflow
the stack). Back-links (NBA → WNBA → NBA) are normal and harmless because of dedupe;
`loops()` lists them so the live view can draw them and the build-order check can name a
real dependency cycle.

### 7. Termination

`isClosed()` is true only when the frontier is empty and nothing is mid-expansion: the
reference's "the queue decides, not the builder" as a check.

### 8. Files

| file | written by | content |
|---|---|---|
| `discovery/graph.json` | `save()`, atomically (tmp + rename) | the whole graph |
| `discovery/events.jsonl` | every mutation, append-only | `node.added`, `edge.added`, `template.added`, `node.status` |

## Use

```bash
node --test 'test/*.test.mjs'                 # or: npm test
node cli.mjs <discovery-dir> stats            # counts, frontier size, template histogram
node cli.mjs <discovery-dir> frontier         # what gets explored next, in order
node cli.mjs <discovery-dir> order            # build order
node cli.mjs <discovery-dir> route <nodeId>   # cheapest replay path to a node
node cli.mjs <discovery-dir> loops            # mutually reachable surfaces
```

```js
import { open, save } from "./store.mjs";
const g = open("never_to_be_pushed/discovery", { target: url });
const { node } = g.addNode({ url, signature, entry: true, modules, interactive });
g.addEdge({ from, to, kind: "click", element: { role: "button", name: "Settings" } });
const n = g.next();            // ...worker expands it...
g.setStatus(n.id, "closed");
save(g, "never_to_be_pushed/discovery");
```
