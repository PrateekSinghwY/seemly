# Capture rules

The seed contains only what the capture serialized. A filter written as an allow-pattern
silently defines the whole evidence base, and every component downstream renders
whatever survived. Every rule here exists because a filter once deleted real content
and the absence was read as a fact about the reference.

## Determinism lock (Playwright, before the first capture)

```
Emulation.setDeviceMetricsOverride   1440x900, deviceScaleFactor 2 (or the decisions.md viewport)
Animation.setPlaybackRate            0
Network.emulateNetworkConditions     fixed values
Network.setBlockedURLs               ADS + ANALYTICS ONLY, explicit host list, every block logged
Page.addScriptToEvaluateOnNewDocument freeze Date.now, performance.now, Math.random,
                                     crypto.randomUUID, Intl timezone
inject CSS                           *,*::before,*::after{transition:none!important;
                                     animation:none!important;caret-color:transparent!important}
await                                document.fonts.ready
```

Gate 0: capture the same state twice, diff byte for byte. Not identical means the lock
is incomplete; do not proceed. **Identical is not correct**: Gate 0 also asserts the
expected theme, locale and login state by value. Theme is state, and a UI kit may read it
from `localStorage` rather than `prefers-color-scheme`, so a fresh profile can render the
light palette three times byte-identically while the real app is dark. Seed the stored
theme key in the profile, then assert the root theme class and body background
(pricelabs/R-B).

Design tokens and CSS custom properties are read with third parties blocked: a chat or
help widget injects its own variables onto `:root`, and counting them clones a blocked
vendor's tokens as the app's (pricelabs/R-C).

## Never block first-party

The block list names ad and analytics hosts explicitly. Anything on the reference's own
domains, its CDN, its auth or identity bootstrap, its data APIs, stays unblocked. Every
blocked request is written with `blockedReason`. If a module renders empty in the
capture, the first check is: did the block list kill the request that feeds it.

## Globals by deny-list

```
Object.getOwnPropertyNames(window)
  .filter(k => !BROWSER_BUILTINS.has(k))
  .filter(k => typeof window[k] === 'object' && window[k] !== null)
```

Serialize each whole (cycle-safe). Never `startsWith('__')` or any other name pattern.
The site's real page-data global is usually named after the site.

## Sources, in order

1. Hydrated DOM at rest (`document.rest.html`) and after the scroll pass
   (`document.scrolled.html`). For server-rendered sites this is the primary source for
   nav, footer, strips and most modules. Provenance kind `html-hydrated`.
2. Every XHR and fetch from navigation start through the interaction pass, body via
   `Network.getResponseBody`, `.meta.json` beside it.
3. Every window global that survived the deny-list.
4. Public API documents as a second witness, never primary.

## The whole surface, on a real instance

- **Dismiss before you count.** An overlay open on load (a goal modal, a product-tour
  guide, a consent prompt) sets `aria-hidden` on the page behind it. Record the interactive
  count, dismiss or suppress every overlay (third-party guides client-side), count again;
  the census uses the second number and the overlay is its own node (pricelabs/R-A).
- **Real instance, not the sample.** A demo or sample record can be pre-rendered and fire
  no data requests; a user-created record of the same template fires the real ones. Find
  or make (within the write rules) a real instance before concluding a surface has no
  contract (pricelabs/R-trap1).
- **Data-volume variants.** A surface can render a marketing or empty layout at zero
  records and a table with extra header actions at one or more. Capture both before
  calling either complete (pricelabs/R-T1).
- **States behind a metered action are captured before it fires**: every computed style,
  AX tree and oracle clip of the flow's steps, then the write (decisions.md, Metered and
  priced writes).
- **Client-state mutations are read, not fired.** Drawing on a map, editing a layer or a
  persisted preference on the reference is read from the object graph (layer definitions,
  paint properties, the component's config) instead of performed (pricelabs/IE2).
- **Recordings and hover sweeps find what a static census cannot**: hover tooltips,
  pre-hidden series, data labels, crosshair widths and layer paint appear only under
  input. A static AX and listener sweep that finds zero new controls is not evidence that
  a surface has no new states (pricelabs/S10).

## The bundle as a source

- An advertised `sourceMappingURL` is not a source map: fetch one before planning on
  original sources; they can all 404 (pricelabs/R-D).
- Modern bundles hide library globals (`window.<ChartLib>` undefined while its containers
  render). Chart series come from the data payload; axes, legend, tooltip chrome and tick
  positions are read off the rendered SVG. Never plan on dumping a runtime config object
  (pricelabs/R-F).
- Mine the bundle for request shapes of controls that were never clicked (sharing,
  restriction bodies, exports) before writing their endpoints; record them as
  bundle-sourced (pricelabs/R-N1).
- A bundle census matches at word boundaries; substring matches report libraries inside
  ordinary words (pricelabs/SC2).

## Inventories that must join

Two captured inventories that feed one flow (autocomplete predictions and their resolved
places, list rows and their detail records) are joined at capture time and the miss rate
printed. Each can look complete alone and be almost disjoint (pricelabs/R-T3).

## The interaction pass, read-only, per page

Scroll in viewport steps until the page stops growing or the configured feed cap; hover
each top-nav item and save the dropdown DOM; open each picker and save it; click each
carousel arrow to both ends; open each module tab; capture 2 above throughout. Nothing
in the irreversible list is clicked. Nothing that navigates away is clicked.

## Text nodes and provenance

Every visible text node, verbatim (curly quotes, nbsp, ellipsis), with module path and
element path and whether it needed an interaction. Every row resolves to `exact`,
`formatted` (raw value plus format), or `ui_copy` (from the bundle, seeded as a table).
`UNRESOLVED` must be 0.

The copy oracle used as a stop condition is scoped to the target's own captured routes and
excludes markup tokens (selectors, SVG path data, colours, attribute fragments), captured
data values and the analyst's own prose. A whole-app bundle string list is not a per-target
oracle (pricelabs/T3).

## Images and fonts

Every `<img>`, `<picture>` source, CSS background image, `<svg><use>` sprite, and every
font binary the browser downloaded: saved by sha256 with a manifest row (URL path, size,
kind, entity ref). Never redraw an icon; never substitute a font without a declared
ceiling.

## Pixel oracle, whole page

Full-page PNG per page and per interaction state at the canonical viewport under the
lock, via `Page.captureScreenshot` with `captureBeyondViewport`. Beside each,
`regions.json`: the box of every module root **including header, sub-nav rows, score or
ticker strips, every column, every promo, footer link groups and legal block**, plus mask
classes: `ad`, `video`, `live-timestamp`, `personalised`. Coverage check: every pixel of
the PNG is inside a listed region or a mask, or the oracle list is defective. Clips are
cropped from the full-page PNG, never re-shot. Hover and focus oracles via
`CSS.forcePseudoState` on every interactive element.

When a clean context is impossible (the human insists on a signed-in profile),
redact-then-shoot: inject `visibility:hidden` on every excluded module's root before the
shutter, assert zero leaks in-page, capture. `visibility`, not `display`, so geometry
holds.

## Scrub

Delete (do not blank) personalisation and identity keys at any depth: session, visitor,
device, user, account, swid, guid, geo, zip, postal, lat, lon, ip, dma, region,
personaliz*, favorite, favourite, recommend, utm_*, fbclid, gclid, every cookie header.
**Scan values too**: emails, phone numbers, token-like strings. Log every deletion. Then
grep the whole capture tree for the developer's identity from `git config`, email
patterns, phone patterns, long tokens. A hit stops the capture.

## Exclusion selectors

Any rule that excludes a module (personalised, account-bound) lives in **one file**,
tests class, id, data attributes and heading text with word-level matching and an
explicit keep-list, and is imported by the capture, the normaliser, the oracle and the
pixel diff. A second copy anywhere is a defect: the class has drifted six times in one
build.

## Snapshot discipline

One T0 for all pages, spread printed. Raw output immutable once written. A re-capture is
a new `raw/<T1>/`, never an edit. Later click-tree nodes are `T0+n`, masked for drift in
the pixel oracle and recorded in `pixel-drift.md`. The frozen clock is T0; relative time
strings are stored twice (verbatim and the timestamp) and asserted equal at verify.

<!-- merged 2026-11-02 from the rl_espn copy: sections the canonical copy had lost -->

# Rules from builds 2026-09-24 to 2026-09-29 (promoted 2026-09-29)

Origins: `scores` = 2026-09-24-espn-scores, `stp` = 2026-09-25-espn-standings-teams-players,
`fb` = 2026-09-27-espn-nfl-ncaaf (see `corrections/`).

## Every control inside a module is a node (scores T#12)
Inside every captured module, enumerate `select`, `[role=combobox]`, `[aria-haspopup]`,
`[role=tab]`, toggles and chevrons, open each one, and record its options or panel as a child
node, including inside tabs or modules ruled out or disabled (the ruling can be reversed and the
control is still part of the surface). A native `<select>` is captured by its `<option>` list
(text, value, selected) and reproduced with a real `<select>`, never a custom listbox. The
per-node inventory fails if a module has an interactive descendant with no child node.

## Every card is clickable until proven otherwise (fb/56-58)
Every element with `cursor: pointer`, a click handler, `[aria-expanded]`, `[role=button]` or a
card-like box is clicked on the reference before its module is called built. What opens
(overlay, replay, drawer) is a node with its own inventory, data capture and animation timeline.
Inside an opened overlay every list row, tab and control is clicked too; a control that re-runs
an animation is sampled at 0 / 300 / 700 / 1500 / 3000 ms. A module whose cards were never
clicked is UNBUILT. An overlay opened from a scrolled position must open in view as it does on
the reference (fb/62).

## Every state of every module gets a T0 clip (scores L10)
A module that switches layout by item state (final, scheduled, to-be-decided) is captured once
per state and compared against its own clip. A state reusing another state's layout is a defect
until a clip proves the reference does the same. A module present in the DOM at 0x0 is
**absent**: read its box in `regions.json` before building from DOM (fb strip lesson).

## Charts (scores T#09)
Every chart is a node with its own hover states. Before building it, sweep the pointer across
the whole plot on the reference and capture per state: the tooltip's DOM and computed styles,
which data fields it prints and in what format, where it anchors, the crosshair or marker, the
highlighted mark, and whether the keyboard reaches it. Record the renderer (SVG paths, canvas, a
charting library's DOM signature) and rebuild to that structure; a library only if it yields the
same DOM and behaviour.

## Motion (scores T#10)
Motion is a captured channel. For every element that moves (live updates, chart draw-in,
carousels, toggles, tooltips), record trigger, duration, delay, easing, animated properties and
keyframes from `document.getAnimations()` and the computed `transition` / `animation` styles,
plus a short frame sequence. Research the best tool for each motion class before building,
rebuild with it, and honour `prefers-reduced-motion`.

## Canvas and runtime animations (scores T#14, fb/56)
A `<canvas>` that animates is a runtime, not pixels. Read the network log while it mounts
(`.riv`, Lottie `.json`, `.wasm`, WebGL) to name the runtime and version, and vendor the same
file and runtime locally. Read what the page feeds it, not what the file defaults to: walk the
canvas's component tree to the instance that holds the runtime, dump every bound input or
view-model property; the default instance shows placeholder data. Reproduce with the same runtime
family, set only the properties the reference sets, and use one shared renderer for many
canvases on a page.

## Menus and interaction states (stp L-menu-hover, stp/22)
Capture `:hover`, `:focus`, `:active` and disabled per item class via `CSS.forcePseudoState` on
every menu surface and every nav design the reference ships; an item converged only at rest is
not converged. Measure these live on the reference, never assume them.

## Paged, sortable tables: every order (stp L-derive-display-rules)
A table whose rows come from an API with server-side sort and paging is captured as the full
order for every sortable column in both directions, all pages, with the page's own request
parameters (read them from the paging request, per sort). One default-sort dataset cannot
reproduce another column's order, and ascending is its own request, not the reverse of
descending.

## Partial records and case drift (stp L-partial-records, L-api-case)
An API that trims a record per request is merged across every captured response before seeding;
never seed from the first response alone. Match category and key names case-insensitively when
the API spells one key two ways.

## Saved DOMs replay inline scripts (stp L-inline-script-oracle)
The oracle loader blocks external scripts only; an inline `document.write` in a saved DOM runs
again and doubles its output. Strip such scripts into an oracle copy and log it.

## Dropdown options are never assumed (stp/15)
A select's option list is the page's own captured list. Every option the clone enables resolves to
a captured page for that exact state; every other option renders native-disabled.

## Account-bound features: the whole graph, with a control account (stp/38, stp/39, fb/72)
For any feature whose effect depends on the signed-in user (follows, favourites, subscriptions,
saved items, preferences):
1. **Nodes:** every kind of thing that can be followed or saved and every control that changes
   it (header buttons, modal rows, rail links, menus, the account flyout's favourites panel).
2. **Edges:** every surface a change touches (rails, feed order and art, nav order, menus,
   headers, listing rows, empty states), found by walking the site with two accounts at the same
   instant and edition: one with the state set (read-only) and a control with none; each
   difference is an edge, recorded in `discovery/<feature>-graph.md`.
3. **Mechanism:** which request carries the state, never the identity values.
4. **The followed entity's own page** in its followed state, measured.
5. **Listing marks:** a followed entity can mark itself on listing surfaces the follow flow never
   visits (a tinted roster row); sweep every surface listing that kind of entity and record where
   the mark appears and where it does not.
6. Build every edge the clone can drive; each unbuildable edge goes to the panel and becomes an
   assumption or gap. Every surface that shows favourites exists and is wired, including the
   account flyout.

## Per-route chrome and breakpoints (stp/40, fb/54, fb/60)
The same chrome can have per-route designs; classify every route by the design it serves before
building a shared component. Measure breakpoints, not one width: for every page type record the
column boxes at 768 / 1024 / 1100 / 1240 / 1280 / 1440 / 1680 / 1920 / 2560, whether a column
hides or stacks and where its cards go, and probe single-pixel edges (N-1 / N / N+1). Record
whether wide layouts are bounded or full-bleed.

## Logged-out, one edition (fb/55 follow-up)
Measurements come from a logged-out browser on the target edition; a logged-in profile hides or
adds modules.

## Page data before API (fb/56)
A module missing from the site's API is looked up in the page's own server-rendered global before
it is declared uncapturable; a direct HTTP fetch of the page often works when a browser is
challenged.

## Declared values, not computed ones (stp L-line-height-as-declared, L-tabular-nums)
When a probe shows a fractional line-height, read the reference's declared value (a ratio vs
px) and write it the same way: equal computed values can round differently in layout and drift
a pixel rows later. Probes of text-bearing cells include `font-variant-numeric` (tabular digits
change auto-layout column widths).

## Logged-in apps with real writes (fantasy, 2026-09-30)
- **Redact at write time, every writer**: account ids (GUID/SWID), JWTs (`eyJ…`), emails, and
  profile-name fields + tokens pass through one redactor before `writeFileSync`. Public-figure
  catalogues (players, teams) are fetched on a separate path that is never run through the
  account redactor, or their names are erased too.
- **Walk a write without firing it**: in Playwright, `page.route` on the app's own write host aborts
  its non-GET requests (the auth refresh still passes, below); in Chrome,
  patch `fetch` + `XMLHttpRequest` in the page to reject writes before the final click. The
  aborted request body is the write shape. Re-read the pending list afterwards to prove nothing
  landed. Only synthetic `@example.com` contacts are ever typed.
- **One live socket per seat**: a second tab on a realtime room kicks the first ("Duplicate
  Connection"). Record frames by attaching CDP `Network.webSocketFrame*` to the open tab; wait
  for the room's own root selector before interacting (loading screens eat clicks).
- **Verify rules live, not from docs**: the help centre was wrong on option lists (public scoring)
  and the spec was wrong on queue semantics (drafted players stay in the stored queue; the view
  filters them). Turn every stated behaviour into a live probe when the surface is reachable.
- **Know which account each tool holds**: the two browsers can be different users; a member-only
  page seen by a non-member renders an error state, not the surface.
- **Let the auth refresh through**: "abort every non-GET" also kills the identity provider's token
  refresh (e.g. a GraphQL `refreshToken` POST); the app then silently never sends its write.
  Allow-list the auth refresh host, abort only the app's own write hosts.
- **Intercept narrowly**: a catch-all `page.route('**/*')` can break cross-origin auth (CORS on
  the token refresh) so the app never reaches its write. Route only the app's write host.
