
## Charts (espn-scores/09)

- Every chart is a node with its own hover states. Before building it, sweep the pointer
  across the whole plot on the reference (points along the x axis, every mark on a scatter)
  and capture per state: the tooltip's DOM and computed styles, which data fields it prints
  and in what format, where it anchors, the crosshair or marker, the highlighted mark, and
  whether keyboard reaches it.
- Record the renderer (SVG paths, canvas, a charting library's DOM signature) and rebuild
  to that structure; a library only if it yields the same DOM and behaviour.

## Motion (espn-scores/10)

- Motion is a captured channel. For every element that moves (live play-by-play updates,
  chart draw-in, carousels, toggles, tooltips), record trigger, duration, delay, easing,
  animated properties and keyframes from `document.getAnimations()` and the computed
  `transition` / `animation` styles, plus a short frame sequence.
- Research the best tool for each motion class on the web before building, rebuild with
  it, and honour `prefers-reduced-motion`.

## Canvas animations (Rive, Lottie, WebGL) — from build espn-scores, 2026-09-24
- A `<canvas>` that animates is a runtime, not pixels: list the network requests while it mounts (`.riv`, `.json` Lottie, `.wasm`) to name the runtime and its version, and vendor the same file and wasm locally.
- Read what the page feeds it, not what the file defaults to: walk the canvas's React fiber up to the component whose hooks hold the runtime instance, find every bound view-model instance (objects with `number()`/`viewModel()`), and dump each property. The auto-bound default instance shows the file's placeholder data; the page's own values live on the instance it binds.
- Reproduce with the same runtime family (webgl2 vs canvas) and set only the properties the reference sets; compare a canvas frame crop against the reference frame.
- Many canvases on one page: use the runtime's shared/offscreen renderer (one GL context), never one context per canvas.

## Every control inside a module is a node — from build espn-scores, 2026-09-24 (correction 12)
- Inside every captured module, enumerate `select`, `[role=combobox]`, `[aria-haspopup]`, `[role=tab]`, toggles and chevrons, open each one, and record its options/panel as a child node — including inside tabs or modules ruled out or disabled, because the ruling can be reversed and the control is still part of the surface.
- A native `<select>` is captured by its `<option>` list (text, value, selected) and the change it makes; its popup is the OS menu, so reproduce it with a real `<select>`, never a custom listbox.
- The per-node inventory fails if a module has an interactive descendant with no child node recorded.

## Every state of every module gets a T0 clip (espn-scores L10)
A module that switches layout by game state (final, scheduled, TBD) is captured once per
state, and each state is compared against its own clip. A state reusing another state's
layout is a defect until a clip proves the reference does the same.

## Stand-in images are masked, not counted (espn-scores L12)
When a repo budget substitutes images, the pixel oracle masks every stand-in image box, and
the free budget goes to the images most visible on the in-scope routes first.

## Paged, sortable tables: capture every order, not one (lesson L-derive-display-rules, espn-standings-teams-players)
A table whose rows come from an API with server-side sort and paging (qualification differs per
column) is captured as the full order for every sortable column in both directions, all pages,
with the page's own request parameters (read them from the Show More request, per sort). One
default-sort dataset cannot reproduce another column's order: ranks exist only for the sorted
stat, and asc is its own request, not the reverse of desc.

## A response can omit what a record needs (lesson L-partial-records, espn-standings-teams-players)
An API that trims a record per request (categories a player has no stats in for this sort) is
merged across every captured response before seeding; never seed from the first response alone.

## Saved DOMs replay inline scripts (lesson L-inline-script-oracle, espn-standings-teams-players)
The oracle loader blocks external scripts only; an inline document.write in a saved DOM runs
again and doubles its output. Strip such scripts into an oracle copy and log it in ASSUMPTIONS.

## Menus: capture the hover state of every item class (lesson L-menu-hover, espn-standings-teams-players)
Dropdown/mega-menu items carry their own hover treatment (ESPN's menu column: 4px-rounded
rgb(221,0,0) fill, white text, no underline). Capture `:hover` per item class via
CSS.forcePseudoState on each menu surface and each reference nav design (the reference ships
more than one nav design across routes); an item converged only at rest is not converged.

## Account-bound features: capture the whole graph, with a control (correction 38, 2026-09-27)

For any feature whose effect depends on the signed-in user (follows, favorites, subscriptions,
saved items, preferences):
1. **Nodes:** list every kind of thing that can be followed / saved and every control that
   changes it (header buttons, modal rows, rail links, menus).
2. **Edges:** list every surface a change touches — rails, feed order and art, nav order, menus,
   headers, empty states — by walking the site with **two accounts at the same instant and
   edition**: one with the state set (the developer's, read-only) and a **control** with none.
   Diff them surface by surface; a difference is an edge. Record it in `discovery/<feature>-graph.md`.
3. **Mechanism:** note which request carries the state (profile API, personalized feed API) —
   never the identity values themselves.
4. **Profiles of the followed things:** capture how a followed entity's own page looks (the
   followed state of its controls, measured).
5. Build every edge the clone can drive from its own state; each unbuildable edge (server-side
   ranking not observable) is decided by the consensus panel and recorded as an ASSUMPTION / GAP.
6. **Follow the follow everywhere the entity appears, not just where it is followed.** A followed
   entity can mark itself on *listing* surfaces (a roster row tinted, a table cell class) that the
   follow flow never visits. Sweep every surface that lists that kind of entity (rosters, stats
   tables, depth charts, switchers, search) on the reference with the account, record where the
   mark appears *and where it does not*, and measure the mark's class and colour with hover.
7. **When the reference's own behaviour is unstable between loads** (an order, a rotation),
   do not chase it: keep the clone's current state and record the ruling as a gap.
8. **An unobservable server-side swap still gets an observable analogue** when the human asks:
   derive it from DB relations the clone already has (tags, single-subject stories), make it
   reversible by the follow state, and prove on/off/on in one flow test.
9. **Never add an item to a captured list by hand.** A list the reference serves (tabs, nav,
   rows) is copied, never extended from memory. Something seen *near* a list (a logo at the
   bar's end) is its own element with its own measured treatment, captured from the live DOM.
10. **The same chrome can have per-route designs.** A reference may serve two headers (legacy vs
    app shell) on different route families. Classify every route by which one it serves before
    building a single shared component, and measure each variant separately.
11. **Measure breakpoints, not widths.** For every page type record the column boxes at several
    viewports (768 / 1024 / 1100 / 1240 / 1280 / 1440 / 1680) and, where a column disappears,
    whether it is hidden or stacked and where its cards go. Probe single-pixel edges (1023 /
    1024 / 1025) for bars that change at a breakpoint.
