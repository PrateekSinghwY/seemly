# The surface graph: how the app is explored and built as one structure

The reference app is a directed graph. The skill discovers it, deduplicates it, orders
it, and then applies the **same per-node procedure** to every node until the frontier is
empty. Nothing is built outside the graph; nothing in the graph is left unbuilt or
unrecorded. This file is the algorithm. RL_BUILD Part 4 (recursion rule) and
BUILD_PROTOCOL Phase 2 (click expansion) are its source; `scripts/orchestrator/` is its
implementation (`explore.mjs` the walk, `build.mjs` the units, `run.mjs` the commands in
SKILL.md sections 4 and 5). Where this file and the code disagree, fix whichever is wrong in
the same change; never leave them apart.

## Definitions

**Node** = one surface in one state: a route, or something a click opens (drawer, modal,
menu, tab, expanded row, picker), in a specific data state (at rest, scrolled, a date
selected, a filter applied). Identity is the pair:

```
node_id = hash( canonical_url_without_tracking_params , structural_signature )
```

`structural_signature` is the DOM skeleton with text and attribute values stripped:
element tag path, roles, module signatures, order. Two pages with the same skeleton and
different content (the NBA and WNBA homes) are **two nodes, one template**. An overlay, modal, menu or
state adds a **content key** to that pair: its title plus the sorted names of its controls (digits
as #; controls in rows, cells, options and long look-alike runs left out as data), so two confirms
with one markup and different words are two nodes, one template, while a list does not split per
row (`page-probe.mjs` `contentKey`; an older keyless node keeps its id until `O requeue --kind`).

**Template** = the equivalence class of nodes sharing a structural signature above a
similarity threshold (default 0.92 on tag-path multiset overlap). One template maps to
one page component or one module archetype in `REGISTRY.md`. This is where reuse comes
from: the graph decides what is the same, not the builder.

**Edge** = one interaction that moves between nodes or changes a node's state:
`click`, `hover`, `keyboard`, `scroll`, `redirect`, `navigation` (href), `write`, and the
interaction kinds `contextmenu`, `dblclick`, `key`, `drag`, `input`, `submit`, `upload`. Edges
carry the element (role, name, selector, plus what replays it: the key, the drag offset, the
synthetic values typed, the fixture file's accept list), the request it fires if any (a `write`
edge fired by another kind records it in `via`), and whether it is reversible, metered or
irreversible.

**Frontier** = nodes discovered but not yet expanded. **Closed** = expanded, every edge
recorded, every child in the graph. **Built** = closed and verified on four channels.

## Algorithm

```
G ← empty graph
frontier ← { entry nodes from INTAKE.TARGET, each in its REACH state }
snapshot(frontier at T0)                          # Phase A, Playwright, one instant

while frontier not empty:
    n ← pop by priority (below)
    if n.template exists and n.template.built:
        register n as a configuration row of that template   # reuse: no new component
    inventory(n)                                  # BUILD_PROTOCOL Phase 1, all 8 states, 4 verdicts
    for each interactive element e in n:
        fire e in Chrome (real input; never synthetic; never irreversible or metered)
        child ← observe(result)                   # new node, state change, navigation, redirect
        if child is a navigation beyond DEPTH:    # INTAKE.DEPTH
            record edge as out-of-scope, real href, GAP row; do not push
        else if child.node_id ∈ G:
            add edge only                         # dedupe: same surface via another path
        else:
            capture(child) as T0+n (Playwright)   # masked for drift in the pixel oracle
            classify child.template
            push child to frontier
    mark n closed
    build(n) or configure(n)                      # Phase C, per node, step 8 before "built"
    verify(n)                                     # Phase D, structure + style + pixels + trace
    write RESUME.md (graph stats, frontier size, built count)

assert frontier empty and nothing capped without a recorded reason
```

Termination is a property of the graph, not a feeling: frontier empty, every node
closed, every node built or configured, every edge either built or recorded as GAP or
external. `graph.json` is the queue, and a node's status is written in the same step that
expands or builds it; the loop ends with `run.mjs status` and `tree`, never on a sense of
completeness. "Capped" is allowed only with a reason recorded on the node (a human ruling, an
irreversible or paid lane, a blocked third party).

## Building: one unit at a time, one agent per unit

`run.mjs plan` turns the closed graph into units (shell, module archetypes, templates) in
dependency order; `next-unit` hands out one whose dependencies are built, with a packet that
is the whole brief (members, captures, what each control opens, replay routes, writes,
selected lessons). A unit may go to a subagent with the packet as its prompt; two agents never
build one template.

## Priority (what to pop first)

First key that differs wins (`graph.mjs` `#compare`):

1. **Writes last**: a node reachable only through a write waits behind every other node.
2. **Entry nodes** in INTAKE order, so the first visible page lands within the deadline.
3. **Highest in-degree template**: the template reached from the most edges is worth the most,
   and every node of it after the first is a configuration row.
4. **Shallower first**: fewer hops from an entry (kept exact as shorter routes appear).
5. **Cheapest first**: fewer interactive elements close faster and unblock their children.

The shell is not popped first; it is *built* first (build order), and it is only knowable once
two pages are in the graph. This priority queue replaces depth-first walking with
backtracking: a backtrack is just the next pop, reached by its replay route.

## Reaching a node: replay routes

Every node is reached by its cheapest route from an entry (multi-source Dijkstra; redirect 0,
hover and scroll 0.5, click, keyboard, navigation, contextmenu, dblclick, key, input and submit 1,
drag 1.5, upload 2, write never). A hash-routed app's route lives in the fragment (`#/list/Kiosk`,
`#!/...`): it is part of node identity and of the replayed URL, so a route is reached directly. The walker jumps to the
last URL-addressable page on the route and replays only the clicks after it, so a URL that
encodes state (`?view=`, `?filter=`) is the cheapest restore and is preferred as identity. The
same routes start the golden traces.

## What the walker does per node

1. Reach it. Close anything open on load (a tour, a consent prompt, a what's-new modal) and
   record each as its own node, reached from the page by a free `redirect` edge: a census taken
   with one open counted a handful of controls where the page had about two hundred.
2. Save its capture under `nodes/<id>/`: screenshot, DOM, AX tree, every JSON response, and
   `inventory.json` (every element, its role and name, and what firing it did).
3. Fire every element once. Links are read in a side tab. Buttons and card-like elements
   (pointer cursor, `[aria-expanded]`, a handler) are clicked; popup triggers and nav items are
   hovered first. What happened decides the edge: URL changed (navigation), a new floating
   surface (modal, menu, popover; scoped to its own root), the skeleton changed in place
   (state: tab, accordion, expanded row), a native dialog or download (recorded), or nothing
   (inert; the human-eye pass asks whether the clone's twin is dead).
4. Fire every other interaction kind (`interactions.mjs`), each from the verified pre-state and
   each a row with an outcome:
   - **right-click** (`contextmenu`) on every element with a contextmenu listener (detected by
     an instrumented `addEventListener`) and on grid cells, rows and chips: one per distinct row
     template, more while they open, STATE_BOUND sampling past that;
   - **double-click** (`dblclick`) on elements with a dblclick listener and on grid cells;
   - **keys** (`key`): each shortcut in the target's `keyboards.json` (`--keyboards`; a probe
     set when the page listens for keys globally and there is no file) once per template, and
     Enter or Space on every control with a click edge, once per template;
   - **drag** on draggable elements, sliders, splitters and resize handles, by a fixed offset; a
     changed box or value is a state;
   - **forms** (`input`, `submit`): submitted empty, filled valid (then submitted: a write,
     aborted on the reference and queued), and one invalid value per constraint, each validation
     state a node (required messages, `aria-invalid`, a disabled submit); a search box gets one
     short query, never the battery;
   - **uploads** (`upload`): the accept list and size limit read off the UI always; an accepted
     and a rejected fixture file only where writes are allowed (the clone).
   The Tab order is saved per node (`focus.json`) for the structure check. Disabled controls are
   inventoried, not fired.
5. A state or overlay re-exposes everything around it; only what is new to it is expanded there.
6. Close the node only when every element has an outcome for every interaction kind that
   applies to it, then save the graph, so a crash resumes at the next pop.

## Writes while walking

Session-ending controls are never fired. Money, messaging, deletion and metered (credit,
token) controls are queued in `pending-writes.jsonl` unless the run says `--risky probe`.
Every non-read request is aborted in the browser, so a control that writes under an innocent
name shows its failure path and is queued with the request it tried; a node reached only that
way is reached through a `write` edge and waits for its BLOCKED step. A metered edge records
the price and kind shown; authorisation is for exactly that, and a different price re-blocks.
Edges that mutate the reference's client state (drawing on a map, editing layers, a persisted
"don't show again") are read from their definitions (layer paint, config), never fired.

## Sampling repeated siblings

STATE_BOUND never bounds an entry page or a page in the walk's scope, and never an in-scope
page's own controls: it only samples repeated row siblings. Rows of one list (siblings sharing a
css path up to their indexes) in a group larger than STATE_BOUND are sampled: five, and more only while they keep leading to different templates,
up to STATE_BOUND. The group, its size and the number tried are recorded on the node. Shell
controls (the same role, name and place) are expanded on two templates and recorded as
inherited elsewhere. A data-volume variant (no records vs some) is a separate state, captured
on purpose, not left to whichever account was open.

## Deduplication and reuse

- A node reached by two paths is one node with two in-edges. The golden trace records
  both paths; the build happens once.
- A template built once is never built again: every later node of that template is a
  `page` plus `page_module` rows, `is_current` markers and params. The post-node block
  prints `component files changed: 0` for it, and a non-zero count is a Reuse Contract
  defect that goes back to the template, not the node.
- A node whose signature falls below the threshold against every template is a new
  template; the builder asks the capture, not its taste, for the anatomy.
- Modules inside nodes are clustered the same way: same module signature across nodes
  means one module archetype with a `params` row per placement.

## What counts as an edge that must be expanded

Every element the inventory lists with a live handler or navigation: nav items and
their dropdown children, pickers and each option, tabs, accordions, carousel arrows to
both ends, "more" and "load more", pagination, sort and filter controls, row and card
clicks, right-click menus, double-click panels, drag handles, form validation states, file
inputs, modal triggers, close buttons, escape and outside-click dismissals, keyboard
shortcuts from `keyboards.json`, deep links and query-param views, redirects (recorded as
edges with the redirect chain), and hover-revealed actions. "Probably nothing behind it"
is not a reason to skip; the queue decides, the builder does not.

## Cost control

- **A scope-driven walk** (`O explore --scope-map scope.json --scope S01,S02`): nodes whose
  scope (the rules `O scope` reads; a route fragment counts as path) is listed outrank every
  other node; an overlay or state with no rule takes its opener's scope. Out-of-scope nodes are
  captured and inventoried but not expanded (`info.shallow`) unless `--expand-out`; entry pages
  are always expanded. `--entries-from <file>` seeds entries (one URL per line, or a JSON list or
  route map). A walk that spends its budget deep in one admin area while working screens stay
  unreached is the failure this exists for.
- DEPTH bounds navigation edges to the target's path prefix by default (all under it); nothing else is bounded. The graph is closed when the frontier is empty, however many nodes that took.
- Feed and pagination edges are expanded to the captured depth, never to the
  reference's advertised total.
- A node that keeps growing (infinite scroll without cap) is capped at the configured
  depth and the cap is recorded, not hidden.
- When the frontier exceeds 200 nodes, the skill writes the template histogram to
  `RESUME.md` (how many templates, how many nodes each) and continues by priority. It
  does not stop to ask. Most of a large frontier is configuration rows of templates
  already built.

## Artifacts

```
discovery/graph.json          nodes, edges, templates, module archetypes, bounds: the queue itself
discovery/events.jsonl        every mutation, append-only (what the live view and a post-mortem read)
discovery/nodes/<id>/         screenshot.png, dom.html, aria.yml, styles.json, widths.json, focus.json,
                              inventory.json (candidates, interactions, forms, files), xhr/, ws/
discovery/pending-writes.jsonl  controls held for BLOCKED, with any request they tried
discovery/tree.md             the graph as a tree from each entry by cheapest route, verdict per node
discovery/graph.html          the live diagram (status colour, kind shape, write edges dashed)
discovery/build.json          units in build order with their status
discovery/packets/<unit>.md   the brief for one unit
```

`graph.json` is the single source for STATUS (`nodes closed / discovered`, `built /
closed`, `frontier size`), for PAGE COMPLETE (every node of DEPTH ≤ bound), and for the
scorecard's click-tree row.

## Why this is the same skill applied again and again

Every node goes through the identical sequence: capture, inventory, expand, build or
configure, converge, verify, record, push children. The skill does not get a different
procedure for a modal than for a page; the graph just hands it the next node. Accuracy
compounds because every node's verification feeds `LESSONS.md`, every lesson becomes a
check, and every check runs on every node after it. The 40th node is cheaper and more
accurate than the 4th, or the rounds trend in the post-node block says so and the run
stops to write the lesson.

## The closed loop: what "use seemly" always means (mandatory, never needs asking)

Asked to build a scope (a component, a flow set, a whole app) with seemly, the run is this
loop, start to finish, every time. The human should never have to restate it.

1. **Walk the reference to CLOSED.** `O explore` until frontier 0. The priority queue with
   cheapest-route replay (Dijkstra) *is* "go deep, backtrack, go deep again", done
   optimally. Plain DFS backtracking in a browser has to replay the whole path for every
   backtrack, and it revisits shared surfaces. The queue reaches each node exactly once, by
   its shortest route, and dedupe by node id and template stops any surface being walked
   twice. Right-clicks, double-clicks, keys, drags, typed input and uploads are walker edges;
   canvas drawing and states behind a write are explored by hand and fed back with `O requeue` /
   `O gap`, so the walker's blind spots become nodes too. After each
   walk, `O requeue --gaps` puts every gap with a retryable reason back on the frontier; the
   walk is not closed while one is left. `O scope --map <scope.json>` tags each node with its
   component, so every count below can be read per scope.
2. **The work list is the graph, never a hand checklist.** Every item on a gap list or
   checklist maps to a node id, or becomes one: add it as an entry and walk it. Building runs
   off `O plan` / `next-unit`. Each unit agent gets its node packet and runs the full per-node
   sequence above: capture, inventory, expand, build or configure, verify on four channels,
   record. A checklist line with no node behind it is the defect this rule exists to stop.
3. **Walk the clone to CLOSED** on an isolated copy (own DB copy, own ports), with writes
   allowed.
3b. **Phase D on every built node** (SKILL.md section 0.4): pixels, structure and accessibility tree,
   style, human eye, widths, network (`api_diff.mjs`), interactions, writes. `O verify --ref
   <ref> --clone <clone> [--scope id] --ws-map ws-map.json --dead-controls` runs all eight per
   matched node pair (pixels, structure with AX tree and Tab order, computed style, human eye
   with dead controls, widths, HTTP and websocket reads, every reference edge of every kind vs
   the clone walk's, writes), an overlay judged on its own region, and writes a check
   record per channel under `<clone>/verify/<node>/`. A node without passing check records is
   `needs-verify`, never built.
4. **Diff the two graphs:** `O compare --ref <ref> --clone <clone>`. Confirm every line by
   hand. Each confirmed line is fixed, and its node goes back on the queue. Compare also writes
   `<clone>/pairs.json`: matched node pairs, ref-only and clone-only nodes, which verify and
   report read.
5. **Repeat steps 3 and 4 until compare has no unconfirmed line.** By then every reference
   node must be built, configured, or closed as GAP / bounded / blocked, with its reason on
   the node.
6. **Login or environment lost mid-loop** (`explore` exits 3, tabs on a sign-in page): stop
   capturing and print `BLOCKED`. Work may continue from existing captures, but every node
   that needed a new capture is marked `needs-capture`, never counted as covered. The loop
   resumes at step 1 for those nodes after re-login (`export-login.mjs`).
7. **Every count reported** (nodes, closed, built, gaps) comes from `graph.json` plus the Phase D
   check records, never from a checklist tally or a test count. `O status [--scope id]` prints
   `verified N / built M / ref-only K`, and `O report --scope id` writes the table of what is
   built end to end and what cannot be built, with each reason.

## Commands

`O` is `node <skill>/scripts/orchestrator/run.mjs`, run from the clone repo's root. Every
command takes `--dir <graph dir>` (default `never_to_be_pushed/discovery`).

| command | what it does |
|---|---|
| `O init --target <url> [--prefix /p]... [--entry <url>]... [--entries-from file]` | create the graph from entry pages |
| `O explore [--max-nodes N] [--only-prefix /area]... [--ws-guard block\|off] [--retries N] [--login-pattern re] [--widths off\|list] [--keyboards keyboards.json] [--scope-map scope.json --scope ids [--expand-out]] [--entries-from file] [--no-interactions]` | walk to CLOSED, one chunk at a time; every interaction kind fired; in-scope nodes first |
| `O visit <url>` | add one more entry page |
| `O requeue <node>` · `O requeue --failed` | put one node, or every give-up of a dead browser, back on the frontier |
| `O requeue --gaps [--reason <text>]` | put every gap with a retryable reason back (the walker's `gapReason`; a gap with no reason counts as retryable) |
| `O gap <node> --reason "..."` | close a node as GAP with a reason |
| `O scope --map <scope.json>` | tag every node with a scope from ordered rules (below) |
| `O status [--scope id]` · `O tree [--scope id]` · `O live` · `O frontier` · `O route <node>` · `O loops` · `O pending` | views; status adds `VERIFY verified N / built M / ref-only K` once pairs exist |
| `O plan` · `O next-unit` · `O packet <unit>` · `O unit-done <unit> [--verified]` | build units in dependency order |
| `O compare --ref <dirs> --clone <dirs> [--scope id] [--out diff.md]` | walked-graph diff, plus `<clone>/pairs.json` |
| `O verify --ref <dirs> --clone <dir> [--scope id] [--node id] [--masks masks.json] [--writes writes.json] [--styles-allow f] [--ws-map f] [--dead-controls] [--ref-prefix p] [--clone-prefix p] [--dpr 1]` | Phase D per node pair: pixels, structure (with Tab order), style, human eye, widths, api (HTTP and ws), interactions (edge by edge), writes; exits 1 when any pair fails |
| `O report [--clone <dir>] [--scope id] [--out file]` | markdown: ref node -> clone node -> each check -> reason, then every ref-only node with its reason |

**scope.json:** `{ "rules": [{ "scope": "S01", "url": "^/app/timecards" }, { "scope": "S02",
"heading": "^Schedule", "kind": "page" }, ...], "inherit": true }`. A rule names any of `url`
(regex on path and query), `title`, `heading`, `breadcrumb`, `label` (regexes), `kind`,
`template`; all it names must match, and the first matching rule wins. With `inherit`, an
untagged node takes the scope of its template's tagged members, and an untagged overlay or
state takes its parent's. Untagged nodes are `unscoped`.

**masks.json** (verify): `{ "masks": [{ "selector": ".person-name", "reason": "synthetic name" },
{ "x": 0, "y": 120, "width": 300, "height": 20, "node": "n_..." }], "regions": [{ "name":
"grid", "selector": "[role=grid]" }], "maxDiffPixels": 0, "threshold": 0.1, "structure":
{ "ignore": ["^Last updated"] }, "api": { "ignore": ["/analytics"] }, "humanEye": { "allow":
[...] } }`. Masks cover synthetic data (names, numbers, dates) on both screenshots; regions
add named areas to the per-region pixel counts, which already include every landmark.

**styles-allow.json** (verify): `{ "ceilings": { "width": 1, "height": 1 }, "allow": [{ "element":
"^button \"Save\"", "prop": "width", "max": 4, "reason": "..." }] }`. A ceiling applies to a property
everywhere (px for lengths, channel units for colours); an allow row to the elements its regex
matches (keys are `role "name"`, digits as `#`), and needs a reason. Default: equal.

**ws-map.json** (verify): `{ "/shifts/list": { "method": "GET", "path": "/api/shifts" } }`, each
reference websocket call name to the clone's HTTP mirror. Request fields compare as query keys
for GET (else body fields; `"request": "query" | "body"` overrides), response fields as for HTTP.
A ws read with no entry fails as `ws call not mirrored`. masks.json may also carry `"widths":
{ "allow": [{ "category": "buttons", "label": "...", "reason": "..." }] }`.

**writes.json** (verify): `write_roundtrip.mjs` rows, each with `node` (a ref or clone node id)
or `at` (a path) saying which pair it belongs to. A node with write edges or pending writes
and no row is not verified: its writes record says which writes have no spec.
