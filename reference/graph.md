# The surface graph: how the app is explored and built as one structure

The reference app is a directed graph. The skill discovers it, deduplicates it, orders
it, and then applies the **same per-node procedure** to every node until the frontier is
empty. Nothing is built outside the graph; nothing in the graph is left unbuilt or
unrecorded. This file is the algorithm. RL_BUILD Part 4 (recursion rule) and
BUILD_PROTOCOL Phase 2 (click expansion) are its source; this makes them mechanical.

## Definitions

**Node** = one surface in one state: a route, or something a click opens (drawer, modal,
menu, tab, expanded row, picker), in a specific data state (at rest, scrolled, a date
selected, a filter applied). Identity is the pair:

```
node_id = hash( canonical_url_without_tracking_params , structural_signature )
```

`structural_signature` is the DOM skeleton with text and attribute values stripped:
element tag path, roles, module signatures, order. Two pages with the same skeleton and
different content (the NBA and WNBA homes) are **two nodes, one template**.

**Template** = the equivalence class of nodes sharing a structural signature above a
similarity threshold (default 0.92 on tag-path multiset overlap). One template maps to
one page component or one module archetype in `REGISTRY.md`. This is where reuse comes
from: the graph decides what is the same, not the builder.

**Edge** = one interaction that moves between nodes or changes a node's state:
`click`, `hover`, `keyboard`, `scroll`, `redirect`, `navigation` (href), `write`. Edges
carry the element (role, name, selector), the request it fires if any, and whether it
is reversible, metered or irreversible.

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

assert frontier empty and no node marked capped
```

Termination is a property of the graph, not a feeling: frontier empty, every node
closed, every node built or configured, every edge either built or recorded as GAP or
external.

## Priority (what to pop first)

1. **The shell**: nodes whose modules appear on every entry node. Built once as a layout.
2. **Highest in-degree templates**: the template reached from the most edges is worth
   the most, and every node of it after the first is a configuration row.
3. **Entry nodes** in INTAKE order, then their children breadth-first, so the first
   visible page lands within the two-hour deadline.
4. **Cheapest first within a level**: nodes with fewer interactive elements close faster
   and unblock their children.
5. **Writes last**: edges of kind `write` are expanded after every read-only edge of the
   node, and only when free and reversible (recorded in `DIRTIED.md`, restored).

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
clicks, modal triggers, close buttons, escape and outside-click dismissals, keyboard
shortcuts from `keyboard.json`, deep links and query-param views, redirects (recorded as
edges with the redirect chain), and hover-revealed actions. "Probably nothing behind it"
is not a reason to skip; the queue decides, the builder does not.

## Cost control

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
discovery/graph.json        nodes (id, url, state, template, status), edges (from, to, kind, element, request, reversible)
discovery/queue.jsonl       the frontier, one line per node, with priority and reason
discovery/tree.md           the closed graph printed as a tree from each entry node, verdict per node
discovery/templates.md      template → component → nodes using it → config rows
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
