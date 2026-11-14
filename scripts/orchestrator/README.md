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
| 2b | streamed live tree: `watch` serves `events.jsonl` over SSE to `watch.html`; events name their agent (`SEEMLY_AGENT` / `--agent`); walker position (`walker.at` per element), `walker.error` / `blocked` / `resumed` / `done`, `unit.claimed` / `done` / `blocked`; stall shown after 90 s silence; replay with a scrubber; seemly-video writes the same events (`video/scripts/video_live.py`) | `watch.mjs` `watch.html` `graph.mjs` `store.mjs` `explore.mjs` `run.mjs` | done 2026-11-14 (`test/watch`) |
| 3 | explore coordinator: pop, reach by replay route, capture, fire every element, push children, until closed; writes aborted, risky names held | `explore.mjs` `page-probe.mjs` `safety.mjs` `gaps.mjs` `bound.mjs` `run.mjs` | done 2026-10-26, e2e on a fixture app (`X-EXPLORE`) |
| 4 | build phase: units in dependency order, one at a time, a packet per unit | `build.mjs` `run.mjs` | done 2026-10-26 (`X-FLOW`) |
| 5 | `SKILL.md` drives the coordinator instead of prose | `SKILL.md` sections 4-5, `reference/graph.md` | done 2026-10-26 |
| 6 | first real audit (reference vs clone, 2 logged-in areas): parallel workers per area, saved-login browsers instead of one CDP window, clean SIGTERM, failed-request log per click, write-only nodes closed as bounded, template sampling, walked-graph diff | `explore.mjs` `compare.mjs` `../lib/export-login.mjs` | done 2026-10-26 |
| 7 | scopes (component tags from ordered rules), `requeue --gaps` on the walker's retryable reasons, node pairs (`pairs.json`), Phase D per pair (`verify`: pixels, structure and AX tree, human eye, api, writes), counts and report from the graph plus check records | `graph.mjs` `compare.mjs` `verify.mjs` `run.mjs` `views.mjs` `cli.mjs` | done 2026-11-14 (`test/scope` `test/requeue` `test/verify` `test/verify-e2e`) |
| 8 | Phase D complete per pair: computed style (walker saves `styles.json`), widths (walker saves `widths.json`), websocket reads vs HTTP mirrors (`ws-map.json`), overlays judged on their own region, `--dead-controls`; check records through `../lib/check-record.mjs` with an output folder | `verify.mjs` `verify-checks.mjs` `explore.mjs` `page-probe.mjs` `../qa/human_eye_lib.mjs` `../qa/labels.mjs` | done 2026-11-14 (`test/verify-checks` `test/verify-e2e`) |

| 9 | every interaction kind a first-class edge: right-click, double-click, documented shortcuts and keyboard activation, drag, form input and submit (empty, valid, one invalid value per constraint), uploads; Tab order per node; per-node invariant over every kind; verify's `interactions` check edge by edge. Hash routes in node identity; a scope-driven walk (`--scope-map --scope`, shallow out-of-scope, `--entries-from`); STATE_BOUND never bounds an entry or in-scope page | `interactions.mjs` `explore.mjs` `graph.mjs` `bound.mjs` `compare.mjs` `verify.mjs` `run.mjs` | done 2026-11-14 (`test/interactions` `test/verify-e2e`) |
| 10 | pages pair across URL schemes: `--pair-map` (exact view keys, `:name` params, regexes on key, URL or route) on compare, verify and report; unmapped views by key, then a flagged fuzzy pair; each view's pairing source in pairs.json and the report. Write round trips read back by a read POST (`multi_read`) the request classifier confirms | `compare.mjs` `verify.mjs` `run.mjs` `../qa/roundtrip_lib.mjs` `../qa/write_roundtrip.mjs` | done 2026-11-14 (`test/pair-map` `test/roundtrip-post`) |

Not done: the walker does not draw on a map or canvas (Chrome does, SKILL.md section 4);
`graph.html` is regenerated per chunk (`watch` is the streamed view); workers share no graph file, so
each area's walk is diffed from its own copy. `verify` compares widths by structural labels
only (no per-width pixels), and a websocket read only against an HTTP mirror named in
`ws-map.json` (never socket to socket).

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
(`gaps.mjs` `markGap`, re-exported by `explore.mjs`). `O requeue --gaps [--reason text]`
(`graph.mjs` `requeueGaps`) puts every gap whose reason is retryable back on the frontier with
its attempts reset, judging by the walker's exported `gapReason` when present and by
`isRetryableReason` otherwise. A gap with no reason at all is retried; out of scope, rulings,
HTTP 4xx, write-only, `session-ending` and `never-open` are not; `load-aborted` is. Without
`--reason` it first runs `gaps.mjs` `requeueWriteOnly`: a node bounded as "reached only through
a write" (or a `load-aborted` gap) whose every write edge in was a page-load read under the
current classifier loses those edges, and it and their openers go back on the frontier.

`O requeue --risky` (`gaps.mjs` `requeueRisky`) reads each walked node's `inventory.json` and
puts back every node holding an element `skipped:risky` that the current `classify` would fire
(its name is no longer risky, or it is a money-word choice a picker may hold). The node's
template forgets its seen keys, so template sampling does not skip it, and `risky-name` rows of
`pending-writes.jsonl` that the rule no longer holds are dropped.

### 9a. Safety rules (`safety.mjs`, `test/safety-defects.test.mjs`)

- **Names** (`classify`): deletion and messaging words anywhere; money and metered words only as
  whole actions (`moneyAction`: "Pay now", "Make payment", "Buy now", "Checkout", "Transfer
  funds", ...), never inside a noun phrase ("Current Pay Period", "Pay code"). A money-word
  option, radio or menu item inside a picker (`inPicker` from `page-probe.mjs`) is `choice: true`:
  the walker fires it, keeps the edge when only reads went out, and notes `riskyChoice` on its row.
- **Load-time reads** (`RequestClassifier.classify({ ..., phase })`): the walker tracks each page's
  phase, `load` from a main-frame document request until its first act (click, key, hover,
  dismiss), else `action`. At load, with `--read-posts auto`, a POST is a read unless a
  `CLEAR_WRITE_WORDS` verb is in its path or its body names a write; the rule is learned as
  `POST <template> (load)`. Read words now include config, permissions, content, banners and
  `get...config` / `goto...config` forms. A write the opened page sent at load is queued
  (`phase: "load"` on the blocked row) and noted on the edge (`loadAborted`), never making it a
  write. A node whose load aborted a write and then showed nothing, or broke, is a
  `load-aborted` gap.
- **Telemetry** (`telemetryHost`): any request to a `TELEMETRY_HOSTS` host, and `/collect`,
  `/beacon`, `/track`, `/events` ... on a host outside the app's site, is aborted and never a
  write or a read.
- **Session-ending routes** (`SESSION_END_URL`, `NeverOpen`): a navigation whose URL chain
  (document requests and main-frame navigations since the last act) holds logout, signout,
  signoff or session-end in a path or fragment throws `SessionEnding` (a `SessionLost`, exit 3).
  So does a one-hop landing on the sign-in page while a fresh tab still has the login; then the
  walk goes on. The opened URL's pattern (origin and path, plus a route fragment) is appended to
  `never-open.jsonl`, the nodes at it become `gap: session-ending`, and edges into them become
  `session-ending` (cost Infinity, never replayed). `load`, `readLink`, `readEntry` (with
  `dir`), the explore loop and the context route (document requests) all refuse a URL on the list.

### 10. Phase D per node pair (`verify.mjs`)

`compare.mjs` `pairPages` first pairs each reference view with a clone view: the `--pair-map`
entry (exact key, `:name` pattern or regex on key, URL or route), else the same view key, else
(map given) a fuzzy match by structure plus control labels, reported for a person to confirm;
`pairs.json` `pages` lists each view's source (map / key / fuzzy / none). `pairNodes` then pairs
each reference node with at most one clone node: same paired view and kind, best score of skeleton similarity (0.5), control
label overlap (0.3) and state title (0.2), one to one. Leftovers are ref-only (with the gap or
bounded reason when the walk recorded one, else "not on the clone") and clone-only. `compare`
and `verify` write them to `<clone>/pairs.json`.

`O verify` then, for every pair, reaches the clone node by its replay route on the clone graph
and runs:

| check | how | fails on |
|---|---|---|
| `pixels` | the saved reference screenshot vs a clone screenshot at the same width, height, DPR and full-page mode; `masks.json` rects or selectors masked on both; built-in PNG codec and pixelmatch's YIQ distance (the repo has no pixelmatch); both shots converted to sRGB first from an embedded ICC profile (Display P3 or any RGB matrix/TRC profile) or gAMA/cHRM (`png-color.mjs`), and browsers launched with `--force-color-profile=srgb`. An overlay: both cropped to the union of its two boxes | any unmasked differing pixel (or `maxDiffPixels`); counts per landmark and named region, plus `diff.png`; a colour profile it cannot convert is skipped "unsupported colour profile <desc>" |
| `structure` | the saved `aria.yml` vs the clone's AX snapshot of the same scope: structural roles, names (digits as `#`), states, order; table rows are data. Plus the saved Tab order (`focus.json`) vs the clone's | a missing or invented entry, or a reordering; a focus stop that differs |
| `style` | the saved `styles.json` (`page-probe.mjs` `styleManifest`) vs the clone's, elements matched by role, name (digits as `#`) and nth; font family, size, weight, line height, colour, background, border width/style/colour, radius, padding, margin, width, height, gap, box shadow | a property beyond its `--styles-allow` ceiling (default equal); no `styles.json` is skipped "ref style not captured" |
| `human_eye` | `../qa/human_eye_lib.mjs` (what `human_eye.mjs` runs) on the reached node, scoped to an overlay; `--dead-controls` clicks every enabled control from a fresh reach in a context that aborts writes | any finding; any dead enabled control |
| `widths` | the saved `widths.json` (`../qa/labels.mjs` labels at the capture width and every sweep width) vs the clone's at the same widths, scoped like the reference | a label that differs at some width beyond what differs at the capture width; no `widths.json` is skipped "ref widths not captured" |
| `api` | the reference node's captured reads (`inventory.json` + `xhr/`) vs the clone's requests while reaching the node, by `METHOD path-template`; its websocket reads (`wsReads` + `ws/`) vs the clone's HTTP mirror named in `--ws-map` | an operation the clone never calls; a query key, request field or response field on one side only; `ws call not mirrored` |
| `interactions` | the reference node's rows (`inventory.json` candidates and interactions) vs the clone walk's rows on the paired node (`edgeDiff`, section 11) | an edge that opens nothing on the clone, opens something only on the clone, or opens a node that does not pair; a file input with other accept types or size limit; one line per edge |
| `writes` | `../qa/write_roundtrip.mjs` on the clone, for rows of `--writes` matching the pair; an `expect` read-back may be a read POST (`method`, `path`, `body`) the request classifier confirms (`../qa/roundtrip_lib.mjs`) | a failed round trip; a node with write edges or pending writes and no row is skipped, so not verified |

Each check writes `<clone>/verify/<clone node>/<check>.json` through `../lib/check-record.mjs`
(`writeCheckRecord(name, record, dir)`, shape `{ ran, count, status, reason, at }`) plus
`<check>.detail.json`; a check that does not apply is `skipped` with a reason starting "not
applicable". The clone graph node gets
`verify: { ref, pixels, structure, style, human_eye, widths, api, interactions, writes, passed, at }` and status `verified`
when it passed. A node counts as verified only when the graph says so **and** every record on
disk agrees (`nodeVerified`), so `O status` and `O report` count from the graph plus records:
`verified N / built M / ref-only K` (built = matched pairs).

### 11. Interaction kinds (`interactions.mjs`)

After the clicks, the walker fires every other kind on the node, each from the verified
pre-state, each target ending as one row of `inventory.json` `interactions` (`kind`, `role`,
`name`, `key` or `case`, `outcome`, `to`, or `unfired` with a reason):

| kind | fired on | edge |
|---|---|---|
| `contextmenu` | elements with a contextmenu listener (`LISTENER_HOOK`, an init script that instruments `addEventListener`), grid cells, rows, chips; grouped by row template, a heuristic group probed once and walked further only when it opened something, STATE_BOUND past that | what the right-click opened |
| `dblclick` | elements with a dblclick listener, grid cells | what it opened |
| `key` | each `--keyboards` shortcut (else `PROBE_KEYS` when the page listens globally) once per template; Enter or Space on each control with a click edge, once per template | what it opened; `sameAsClick` on activation rows |
| `drag` | `[draggable]`, sliders, focusable separators, dragstart listeners, small resize-cursor handles; moved by `DRAG_BY` px | a state when the box, value or skeleton changed |
| `input` / `submit` | each form or field group: submit empty; fill valid (`syntheticValue`), then submit (a write, aborted on the reference); one invalid value per constraint (`invalidValues`), submitted; a search box gets one query | the validation state (`formState`: invalid fields, messages, disabled submit) |
| `upload` | each file input: accept list and size limit always; with `--allow-post`, `fixtureFile` accepted and rejected | what the page showed |

A state that keeps the skeleton (a message in place, a moved handle) is its own node keyed by
the interaction (`drag:separator:Resize pane`), never merged into the page. Every edge records
what replays it, and `replayEdge` replays any kind for the walker's `reach` and verify's
`reachClone`. `focus.json` is the Tab order (`focusOrder`). The invariant
(`interactionInvariant`) holds a node open until every row is an edge, a fired result or a known
reason.

`compare.mjs` `edgeDiff` is the `interactions` check: each reference row is matched to the clone
row of the same kind, key or case, role and name (digits normalised); the clone's target must
pair with the reference's (`pairs.json`), or both change nothing, or both end in the same fired
result. A matched control with no row on the clone (no listener, no binding) changes nothing.
Write rows belong to `writes`; a shortcut declared `implemented: false` is listed, not failed.

### 12. Hash routes and a scope-driven walk

`canonicalUrl` keeps a fragment that carries a route (`#/...`, `#!/...`), cleaned like a query;
`meta.hashRoutes` (set by the walker when a fragment-only change rebuilt the page) keeps any
fragment. Families (`bound.mjs` `admit`) and views (`compare.mjs` `viewKey`) include the route.
`g.setWalkScope({ rules, ids, expandOut })` (`--scope-map --scope`) puts in-scope nodes and
entries first in the queue; a node's `walkScope` comes from the rules (path with and without
the fragment), an overlay or state without a rule inherits its opener's. Out of scope and not
an entry: captured and inventoried, every candidate `unfired: shallow`, `info.shallow`. `admitUrl`
never bounds an entry or an in-scope URL, and a walk re-opens any such node an earlier walk
bounded (`g.reread` replaces its placeholder skeleton). `--entries-from` (`readEntriesFile`)
seeds entries.

### 13. Files

| file | written by | content |
|---|---|---|
| `discovery/graph.json` | `save()`, atomically (tmp + rename) | the whole graph |
| `discovery/events.jsonl` | every mutation, append-only | `node.added`, `edge.added`, `template.added`, `node.status` |
| `<clone>/pairs.json` | `compare`, `verify`, `report --pair-map` | page pairing (map / key / fuzzy / none), matched pairs, ref-only (with reasons), clone-only |
| `discovery/nodes/<id>/` | the walker | `screenshot.png` `dom.html` `aria.yml` `styles.json` `widths.json` `focus.json` `inventory.json` (candidates, interactions, forms, files) `xhr/` `ws/` |
| `<clone>/verify/<node>/` | `verify` | a record and detail per check, `ref.png` `clone.png` `diff.png` (`*.crop.png` for an overlay) `clone.aria.yml` `clone.styles.json` |
| `<clone>/verify/report[-scope].md` | `report` | the end-to-end table |

## Use

The commands SKILL.md runs, from the clone repo's root (`RL_REPO` overrides):

```bash
node run.mjs init --target <url> [--prefix /path] [--entry <url>]...
node run.mjs explore --max-nodes 40 [--risky probe] [--allow-post <regex>] [--cdp http://127.0.0.1:9222] [--headed]
node run.mjs status | tree | live | pending | frontier | route <id> | loops
node run.mjs watch [--port 4777] [--dir d] [more dirs]           # streamed live tree, agents, blockers, replay
node run.mjs requeue <id> | requeue --failed | requeue --gaps [--reason <text>] | requeue --risky | gap <id> --reason "..."
node run.mjs explore --dir <copy> --only-prefix /area ...       # one parallel worker per area
node run.mjs explore ... --ws-guard block|off --retries 3 --login-pattern <regex> --widths off|1024,1280
node run.mjs explore ... --keyboards <repo>/keyboards.json      # documented shortcuts on every template
node run.mjs explore ... --scope-map scope.json --scope S01,S02 [--expand-out] [--entries-from entries.txt]
node run.mjs scope --map scope.json                             # tag nodes by component
node run.mjs status --scope S01 | tree --scope S01              # per scope
node run.mjs compare --ref <dirs> --clone <dirs> [--scope S01] [--pair-map pair-map.json] --out diff.md   # + <clone>/pairs.json
node run.mjs verify --ref <dirs> --clone <dir> [--scope S01] [--node <id>] --masks masks.json --writes writes.json \
  --ws-map ws-map.json [--styles-allow styles-allow.json] [--dead-controls] [--pair-map pair-map.json]
node run.mjs report --clone <dir> --scope S01 [--pair-map pair-map.json]   # <clone>/verify/report-S01.md
node run.mjs plan | next-unit | packet <unit> | unit-done <unit> [--verified] | unit-blocked <unit> --reason "..."
node run.mjs <any> --agent <name>                                # who the live view shows for this process
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

| `png-color.mjs` | reads PNG colour chunks (iCCP, sRGB, gAMA, cHRM) and converts tagged screenshots to sRGB before the pixel diff; an unconvertible profile makes the pixel check "skipped", never passed |
