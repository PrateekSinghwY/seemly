
## chart_hover_parity (espn-scores/09)

The same pointer sweep on reference and clone yields the same tooltip text per sampled
point, the same highlighted mark, and a tooltip box within 2px. A chart with no captured
hover record fails.

## motion_parity (espn-scores/10)

Every captured animation has a clone counterpart with the same trigger, duration (+-10%),
easing and animated properties, and a reduced-motion variant. A moving reference element
with a static clone fails.

## Canvas animation parity is proven per play, side by side (espn-scores/14)
For every canvas or WebGL animation (Rive, Lottie, three.js), the proof is a clip screenshot of
the same play on the reference and the clone, taken after the animation settles (>= 4s),
for each variant the animation takes as input (made / missed, home / away, 2PT / 3PT, both
leagues). The clip names the play by its text, not by index. When the human sends a
screenshot of an animation, answer with this pair before building anything: it is a
question about whether the thing exists, and the pair is the answer.

## Font parity per text node, every route (espn-scores L9)
Height and box parity do not prove typography. After step 8 on a route, diff every visible
text node's font family, size, weight, colour and transform against the reference, matched
by text (`sb_fontdiff.mjs`). The route is converged only when the list is empty or each line
is a declared ceiling. Run it on every state of the route, not only the first page.

## Click traces replay the reference walk (espn-scores 16)
The DFS walk's edges become golden traces (`scripts/traces/*.json`): for each control, by
label, what it did on the reference. The runner looks inside `main` before the shell (a
short label also names a nav link), activates state controls directly (a pointer click can
land on sticky chrome), and accepts a redirect to the league home or a disabled control as
the repo's link rule. Every waiver carries its reason in the trace file.

## no-report-stop (correction 11)
Before ending any turn: is the message one of PREFLIGHT FAILED / BLOCKED / SESSION CHECKPOINT / DONE?
If not, do not end the turn; write the progress into RESUME.md and take the next queue item.
A human's mid-run question gets a one-line answer inside the work, not a closing report.

## stop-self-audit (correction 12)
At every SESSION CHECKPOINT and before DONE: `node tools/ui_gap.mjs <pix configs...>` writes
discovery/<build>/UI-GAP.md: per route, modules passing / total, modules missing in the clone,
sub-component deficits (pix `tree`), pixel %, moved modules, missing links; plus every queue node
with no verdict. Each miss gets a cause and the process change that prevents it. A stop without
a fresh UI-GAP.md is incomplete.

## nested-tree (correction 12)
A module passes only when its sub-component tree matches: counts per role (table, row,
columnheader, cell, combobox, option, button, link, img, heading level, list, listitem, tab)
equal between reference and clone (pix `tree`). A component is built when its whole tree is.

## dropdown-options-captured (correction 15)
For every select / dropdown on a built page: (1) its option list is the page's own captured
list; (2) every option the clone enables resolves to a captured page for that exact state,
never a synthesized or re-sorted variant of another state; (3) every other option renders
native-disabled. Gate: a script walks each served page's selects and asserts each enabled
option's target is served by the API (200) and was captured (provenance), and that the option
labels equal the capture's.

## Cell-by-cell table check (lesson L-derive-display-rules, espn-standings-teams-players)
When a front end formats API values (toFixed on printed totals, made-att pairs, blank for '-'),
write a checker that asks the clone for every captured sorted page and compares every printed
cell (rank, name, team, position, each stat) before converging pixels. Espn: check_stats.py,
248/252 equal, 4 = reference drift listed apart. | espn-standings-teams-players/L-derive-display-rules |

## Image walkers cover every table (lesson L-new-image-tables, espn-standings-teams-players)
The vendored-image gate walks named seed tables; a new table carrying image paths is added to it
in the same change, or its images are silently never vendored (a blank slot the gate misses).
| espn-standings-teams-players/L-new-image-tables |

## No gate shares the dev server's build dir (lesson L-shared-next-distdir, espn-standings-teams-players)
A gate that starts its own Next must run it from a copy of frontend/, so its `.next` is its own.
T1: grep every gate for a `next dev|start` spawn whose cwd is frontend/ — any hit fails. Proof of
isolation: the developer's `frontend/.next/static` mtime is unchanged across a gate run.
| espn-standings-teams-players/correction-21 |

## One destination, one disabled state on every surface (lesson L-disabled-parity, espn-standings-teams-players)
A link ruled disabled on one surface is disabled on every surface that carries it (pillar hover
menu, league bar, rails, footer) — never live-by-redirect in one and grey in another. Apply the
ruling in the shared service, not per surface, and gate it: for each pair of surfaces listing
the same items, every shared label has the same disabled state (`check_nav_parity.py` shape;
must report `ran: true` and a non-zero compared count).
| espn-standings-teams-players/correction-22 |

## Disabled takes no hover (lesson L-disabled-no-hover, espn-standings-teams-players)
Disabled = grey + `cursor: not-allowed` + no hover or focus effect of the live item (no fill,
no underline, no colour change) + opens no flyout/menu. Assert on hover: a disabled item's
computed background/colour/decoration equal its at-rest values and the cursor is not-allowed.
| espn-standings-teams-players/correction-22 |

## Human-eye QA layer (correction 37, 2026-09-27) — runs after EVERY built thing

Pixel diffs against an oracle pass while a person still sees a defect at a glance. After each
built component, page, flow or data change — before calling it done — run the human-eye layer:

1. **Repo gate (T1):** `scripts/check_distinct_crests.py` — two different teams, or the two
   players a card shows, never render the same image file (wired into `verify.sh`).
2. **Browser pass (T2):** `discovery/tools/qa_human_eye.mjs` over every built route (ROUTES env
   to scope) — broken images; one image for two different names in a card / row; text clipped by
   its box (hidden labels and reveal badges excepted); controls with no accessible name; enabled
   date cells with no data behind them. Exits 1 on any finding; writes `discovery/qa-human-eye.md`.
3. **Interaction states vs the reference (T3 checklist, measured live, never assumed):** hover,
   focus, active and disabled of every control the change touched — e.g. the scoreboard buttons
   hover light blue rgb(222,232,250), not a solid fill; a date the clone does not hold keeps the
   reference's tone but is disabled with a reason.
4. **Semantics a person reads:** dates vs headings (the reference's own time-zone rule), button
   sets (Highlights else Play-By-Play), counts, names, logos — each compared on the live
   reference for the same record, not inferred from one other record.

A finding blocks "done". The report to the human names what the layer checked and what it did not.
5. **Stand-in media:** an asset budget that remaps files can make a key render a *different*
   picture. Any feature that picks an image to *mean* something (a followed team's photo, a
   player's face) must have its candidates kept as genuine files, and the human-eye pass must
   look at the rendered picture, not the path (a "Heat" key showed a Denver jersey).
6. **Structural label diff, live vs local, per route** (`struct_audit.mjs`): every bar/tab item,
   short heading, table header and button on both, same viewport; local-only labels are
   invented, live-only labels are missing. Pixel checks scoped to modules never see an extra
   tab or a wrong global bar — this does. Wait for the live page to render (scroll + settle).
7. **More than one viewport.** Build-time checks at one width hide overflow and alignment
   failures at every other. Probe at least 1024, 1280, 1440, 1680: horizontal scroll, column
   x-positions and centring against the live reference at the same widths.

## Build 2026-09-27-espn-nfl-ncaaf, corrections 50-59 (2026-09-28) — each is a gate, not a checklist

- **C-width-sweep (corr 54):** every route is compared with the reference at 1024, 1280, 1440, 1680,
  1920 and 2560 wide: x of the first and last item of every shell bar (strip, global nav, league bar,
  team header, sub-nav) and of the page title and main card must match within 2 px. A single canonical
  width hides every centring defect above it (the team header hugged the left from 1441 up).
- **C-shell-is-contextual (corr 54):** shell modules (header scores strip, league bar order) are
  re-inventoried on EVERY page template, not built once from the home page: the strip follows the
  page's league and date. A shell built from one capture is presumed wrong on every other template.
- **C-mask-is-not-a-pass (corr 54):** a module masked for live drift is still diffed on structure and
  on every control's outcome; a mask may hide pixels, never a missing control.
- **C-every-card-is-clickable-until-proven (corr 56, 58):** every element with `cursor: pointer`, a
  click handler, `[aria-expanded]`, `[role=button]` or a card-like box is clicked on the reference
  before its module is called built. What opens (overlay, replay, drawer) is a node with its own
  inventory, data capture and animation timeline. A module whose cards were never clicked is UNBUILT.
- **C-overlay-internals (corr 57):** inside an opened overlay every list row / tab / control is
  clicked too; a control that re-runs an animation is recorded with frame samples (0/300/700/1500/3000
  ms) and the clone must reproduce the same sequence.
- **C-animation-runtime (corr 56):** read the page's network log when a surface opens: a `.riv`,
  Lottie JSON, canvas or WebGL runtime means the reference animates there; the clone uses the same
  asset and runtime (self-hosted) and drives the same inputs.
- **C-logged-out-state (corr 55 follow-up):** measurements come from a logged-out, US-edition browser;
  a logged-in profile hides or adds modules (the Game Odds "See More Odds" link shows logged out only).
- **C-no-chart-focus-ring (corr 59):** clicking or hovering any chart (Recharts, SVG) never draws a
  focus outline or a native `<title>` tooltip; keyboard focus on the chart surface keeps a visible ring.
  Probe: mouse-click the plot, assert activeElement outline is none; Tab to it, assert a ring.
- **C-disabled-no-indicator (corr 50):** a disabled tab/link never shows the active or hover indicator.
- **C-no-silent-partner-drop (corr 55):** a module is never left out as "partner"/"betting"/"promo" by
  the builder's own call; leaving a reference module out needs a human ruling quoted verbatim.
- **C-page-data-before-api (corr 56):** a module missing from the site API is looked up in the page's own
  SSR global (`__espnfitt__`) before it is declared uncapturable; a direct HTTP fetch of the page often
  works when a browser is challenged.
- **C-arbitrary-shadow-order (2026-09-28, found by measuring):** Tailwind v4 drops an arbitrary
  `shadow-[<colour>_<x>_<y>_<blur>_<spread>]` written colour-first: no CSS is generated and the box
  has no shadow, silently, on every card that uses it. Write offsets first (`shadow-[0px_2px_8px_0px_rgba(...)]`).
  T1: `grep -rE 'shadow-\[(rgba?|#)' frontend/components frontend/app` must be empty. General rule: a
  class in the markup is not evidence of a style; assert the computed value.
- **C-write-round-trip-everywhere (correction 63, general rule):** every write control (Follow, favourite,
  subscribe, toggle that persists) on every surface — including controls inside overlays, cards and lists —
  goes through the one shared store and is proven by a round trip: click, wait for the write request to
  finish, hard reload, assert the same state on that surface AND on every other surface that shows the same
  target, reverse it, reload, assert again. The check restores the store exactly (re-add removed, delete
  added) and targets controls by a stable id (`data-follow="<kind>-<id>"`), never "first button". A control
  the clone cannot back renders disabled with a reason; it is never hidden. Tool:
  `discovery/tools/follow_roundtrip.mjs`. Optimistic UI is allowed, but the verdict waits for the response.
- **C-rendered-means-interactive (correction 65):** anything the clone renders is seeded, so every
  control on it works: a rendered player or team is followable, whatever surface shows it. If the
  write needs a row the seed lacks (a player seen only on a card), derive the row from the fields the
  capture already has; do not disable the control. The only honest alternative is not rendering the
  thing at all. Gate: for each write control, count rendered targets with no backing row = 0
  (tools/derive_card_players.py closes the replay-card case; follow_roundtrip.mjs includes a card-only player).
- **C-wire-at-creation (correction 64):** a flow is not created until its wiring is tested in the same
  change: every control that writes (Follow, favourite, subscribe) is traced to the one store, and every
  surface that reads that store (rail, manage modal, roster highlight, player/team headers, overlays) is
  checked after the write and after a reload. Build the round-trip test with the control, not after the
  human asks. Every surface carries a stable `data-favorite` / `data-follow` id so the test can find it.
- **C-zero-size-is-absent (strip lesson, 2026-09-28):** a module present in the captured DOM at 0x0 (the
  legacy `#global-scoreboard` on the front page and league homes) is ABSENT, not a module to build. Before
  building from DOM, read its box in regions.json / the full-page PNG; a 0x0 box means render nothing.
  The clone had drawn a 65px strip the reference never showed on those five pages.
- **C-media-shared-clips (correction 70):** every video and podcast the reference shows is BUILT: its module,
  its own captured title / heading / description / thumbnail / duration, in the reference's layout. Only the
  playable file is shared: one clip per sport family (one basketball clip for NBA + WNBA, one football clip for
  NFL + NCAAF; podcasts reuse their family's clip). Never drop a video module because video content is heavy,
  never show the clip's own headline in place of the slot's. Gate: every rendered video/podcast control plays
  (no disabled play buttons on in-scope leagues) and its caption equals the captured one.
- **C-builder-contracts (2026-09-29 merge lessons):** before starting parallel builders, the coordinator fixes
  per builder: file ownership (no two builders edit the same component), a migration revision id + parent,
  id ranges for appended rows, image-file allowance, and the shared components/tables to extend (never fork).
  At most 3 builders, no helper agents, tests only on their own ports.
