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
| 0 | skill under git, baseline commit | `.gitignore` | done 2026-10-14 (local only, by choice) |
| 1 | graph engine: format, dedupe, templates, priority queue, shortest path, build order, loops | `heap.mjs` `algorithms.mjs` `graph.mjs` `store.mjs` `cli.mjs` | done 2026-10-14 |
| L | learning engine | `../../learning/` | done 2026-10-14; packets call `select` per unit since 2026-10-26 |
| 2 | live diagram from the graph | `views.mjs` (`graph.html`, `tree.md`) | done 2026-10-26 |
| 3 | explore coordinator: pop, reach by replay route, capture, fire every element, push children, until closed; writes aborted, risky names held | `explore.mjs` `page-probe.mjs` `safety.mjs` `bound.mjs` `run.mjs` | done 2026-10-26, e2e on a fixture app (`X-EXPLORE`) |
| 4 | build phase: units in dependency order, one at a time, a packet per unit | `build.mjs` `run.mjs` | done 2026-10-26 (`X-FLOW`) |
| 5 | `SKILL.md` drives the coordinator instead of prose | `SKILL.md` sections 4-5, `reference/graph.md` | done 2026-10-26 |
| 6 | first real audit (reference vs clone, 2 logged-in areas): parallel workers per area, saved-login browsers instead of one CDP window, clean SIGTERM, failed-request log per click, write-only nodes closed as bounded, template sampling, walked-graph diff | `explore.mjs` `compare.mjs` `../lib/export-login.mjs` | done 2026-10-26 |
| 7 | scopes (component tags from ordered rules), `requeue --gaps` on the walker's retryable reasons, node pairs (`pairs.json`), Phase D per pair (`verify`: pixels, structure and AX tree, human eye, api, writes), counts and report from the graph plus check records | `graph.mjs` `compare.mjs` `verify.mjs` `run.mjs` `views.mjs` `cli.mjs` | done 2026-11-14 (`test/scope` `test/requeue` `test/verify` `test/verify-e2e`) |

Not done: the walker does not drag, draw, type or upload (Chrome does, SKILL.md section 4);
the live diagram is regenerated per chunk, not streamed; workers share no graph file, so
each area's walk is diffed from its own copy. `verify` does not run computed style or the
width sweep (their scripts run on their own), does not diff websocket frames, and runs
human_eye on the page under an overlay, not on the overlay alone.

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

### 8. Scopes

`O scope --map scope.json` tags each node with a scope (a component id) from ordered rules on
URL pattern, title, heading, breadcrumb (from `info.breadcrumb` or the node's saved AX tree),
label, kind and template; the first rule that matches wins (`graph.mjs` `tagScopes`). Then an
untagged node takes the scope its template's tagged members agree on, and an untagged overlay
or state takes its parent's, until nothing changes. Everything else is `unscoped`. `status`,
`tree`, `compare`, `verify` and `report` all take `--scope <id>`.

### 9. Gaps that can be retried

The walker records why it gave up on a node: `gapReason: { code, retryable, message }`
(`explore.mjs` `markGap`). `O requeue --gaps [--reason text]` (`graph.mjs` `requeueGaps`) puts
every gap whose reason is retryable back on the frontier with its attempts reset, judging by
the walker's exported `gapReason` when present and by `isRetryableReason` otherwise. A gap
with no reason at all is retried; out of scope, rulings, HTTP 4xx and write-only are not.

### 10. Phase D per node pair (`verify.mjs`)

`compare.mjs` `pairNodes` pairs each reference node with at most one clone node: same view
key (path family plus view flags) and kind, best score of skeleton similarity (0.5), control
label overlap (0.3) and state title (0.2), one to one. Leftovers are ref-only (with the gap or
bounded reason when the walk recorded one, else "not on the clone") and clone-only. `compare`
and `verify` write them to `<clone>/pairs.json`.

`O verify` then, for every pair, reaches the clone node by its replay route on the clone graph
and runs:

| check | how | fails on |
|---|---|---|
| `pixels` | the saved reference screenshot vs a clone screenshot at the same width, height, DPR and full-page mode; `masks.json` rects or selectors masked on both; built-in PNG codec and pixelmatch's YIQ distance (the repo has no pixelmatch) | any unmasked differing pixel (or `maxDiffPixels`); counts per landmark and named region, plus `diff.png` |
| `structure` | the saved `aria.yml` vs the clone's AX snapshot of the same scope: structural roles, names (digits as `#`), states, order; table rows are data | a missing or invented entry, or a reordering |
| `human_eye` | `../qa/human_eye.mjs`, run as a child process on every clone page in one browser | any finding |
| `api` | the reference node's captured reads (`inventory.json` + `xhr/`) vs the clone's requests while reaching the node, by `METHOD path-template` | an operation the clone never calls; a query key, request field or response field on one side only |
| `writes` | `../qa/write_roundtrip.mjs` on the clone, for rows of `--writes` matching the pair | a failed round trip; a node with write edges or pending writes and no row is skipped, so not verified |

Each check writes `<clone>/verify/<clone node>/<check>.json` in the check-record shape
(`{ ran, count, status, reason, at }`) plus `<check>.detail.json`; a check that does not apply
is `skipped` with a reason starting "not applicable". The clone graph node gets
`verify: { ref, pixels, structure, human_eye, api, writes, passed, at }` and status `verified`
when it passed. A node counts as verified only when the graph says so **and** every record on
disk agrees (`nodeVerified`), so `O status` and `O report` count from the graph plus records:
`verified N / built M / ref-only K` (built = matched pairs).

### 11. Files

| file | written by | content |
|---|---|---|
| `discovery/graph.json` | `save()`, atomically (tmp + rename) | the whole graph |
| `discovery/events.jsonl` | every mutation, append-only | `node.added`, `edge.added`, `template.added`, `node.status` |
| `<clone>/pairs.json` | `compare`, `verify` | matched pairs, ref-only (with reasons), clone-only |
| `<clone>/verify/<node>/` | `verify` | a record and detail per check, `ref.png` `clone.png` `diff.png` `clone.aria.yml` |
| `<clone>/verify/report[-scope].md` | `report` | the end-to-end table |

## Use

The commands SKILL.md runs, from the clone repo's root (`RL_REPO` overrides):

```bash
node run.mjs init --target <url> [--prefix /path] [--entry <url>]...
node run.mjs explore --max-nodes 40 [--risky probe] [--allow-post <regex>] [--cdp http://127.0.0.1:9222] [--headed]
node run.mjs status | tree | live | pending | frontier | route <id> | loops
node run.mjs requeue <id> | requeue --failed | requeue --gaps [--reason <text>] | gap <id> --reason "..."
node run.mjs explore --dir <copy> --only-prefix /area ...       # one parallel worker per area
node run.mjs explore ... --ws-guard block|off --retries 3 --login-pattern <regex>
node run.mjs scope --map scope.json                             # tag nodes by component
node run.mjs status --scope S01 | tree --scope S01              # per scope
node run.mjs compare --ref <dirs> --clone <dirs> [--scope S01] --out diff.md   # + <clone>/pairs.json
node run.mjs verify --ref <dirs> --clone <dir> [--scope S01] [--node <id>] --masks masks.json --writes writes.json
node run.mjs report --clone <dir> --scope S01                    # <clone>/verify/report-S01.md
node run.mjs plan | next-unit | packet <unit> | unit-done <unit> [--verified]
```

Engine views and tests (the end-to-end test needs Playwright, resolved from `RL_REPO`):

```bash
RL_REPO=<clone repo> node --test 'test/*.test.mjs'
node cli.mjs <discovery-dir> stats [scope]    # counts, frontier size, template histogram
node cli.mjs <discovery-dir> scopes           # nodes and statuses per scope
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
