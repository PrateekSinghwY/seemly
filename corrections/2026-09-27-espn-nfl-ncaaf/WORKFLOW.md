# seemly: how the workflow really works (and where it does not)

Written 2026-09-29, after the NFL / NCAAF build (PR #9). Honest about what is and is not there.

---

## 1. Is there reinforcement learning? No.

Nothing in seemly trains a model, updates weights, or optimises a reward. What it has is a
**human-in-the-loop rule accumulator**:

```
you correct me  ->  correction saved verbatim   (corrections/<build>/<nn>.md)
                ->  generalised into a rule      (overlay/checks.md, principles.md)
                ->  where possible, a gate       (scripts/check_*.mjs|py, run on every commit)
                ->  next session reads the rules before doing anything
```

Example (correction 65): "every rendered player can be followed".
- Saved as `corrections/.../65.md`.
- Became rule `C-rendered-means-interactive` in `overlay/checks.md`.
- Became a test, `tools/follow_roundtrip.mjs`, which includes a card-only player.
- The fix was data: `derive_card_players.py` created 5,452 player rows, so no Follow is disabled.

What that loop does well: a mistake you name once is checked forever. What it does badly: it only
learns what you name. A class of mistake nobody has named yet is not caught (that is why section 7,
the QA layer, is needed).

---

## 2. The algorithms actually used

| Idea | Used? | Where and how |
|---|---|---|
| **Graph** | Yes | The app is modelled as a directed graph. A node is one surface in one state (`node_id = hash(url, DOM skeleton)`). An edge is one interaction (click, hover, key, scroll, navigation, write). Source: `reference/graph.md`. |
| **Queue (priority queue)** | Yes | The frontier. Order: the shell first, then the templates reached from the most edges, then entry pages breadth-first, cheapest first, writes last. |
| **BFS** | Yes | Children are explored breadth-first from each entry page, so the first page is usable early. |
| **Dedupe / hashing** | Yes | A node already in the graph only adds an edge. That is why 14,000 team-tab states did not become 14,000 components. |
| **Clustering (templates)** | Yes | Nodes whose DOM skeletons overlap ≥ 0.92 are one template = one component; every later node is a data row. |
| **Tree** | Partly | The click tree per page (`tree.md`) is the BFS tree of the graph. |
| **Prim's (minimum spanning tree)** | No | Not needed: we must visit every node, not connect them cheaply. |
| **Dijkstra / shortest path** | No, but useful | Would answer "shortest click path to reach state X" (for building test traces). Today paths are recorded as found, not minimised. A candidate improvement. |
| **Diffing** | Yes | Pixel diff per module (pixelmatch-style count of differing pixels), per-property computed-style diff per element, text diff, href diff. |

### Worked example: the header scores strip (one node, expanded)
```
pop node  /nfl/scoreboard  [HeaderScoreboard]
inventory: 2 selects, Prev, Next, 16 cells, Full Scoreboard
fire each element on the reference (Playwright, US edition):
  league select -> NCAAF      => state change (new node: strip@ncaaf)       push
  date select   -> Week 2     => state change (strip@nfl@w2)                push
  Next                        => carousel step (strip@offset1)              push
  cell hover                  => menu slides in (strip@cell-hover)          push
  Gamecast link               => navigation /nfl/game/_/gameId/…            edge only (node exists)
  Tickets                     => external vividseats                        edge, disabled by rule
measure each new state (boxes, computed styles, timings: 0.2s slide, 0.7s page)
build: HeaderScoreboard + HeaderScoreCell, one component for all 4 leagues (data rows)
verify: same clicks on the clone, same outcomes
```

### How several deep flows are explored
Each child node repeats the same procedure, so depth is unbounded but finite:
```
/nfl/team/_/name/buf           (team home)
 └─ Stats tab                  (team_tab stats)
     └─ season select 2012     (state: season=2012)
         └─ Team view tab      (state: type=team)
             └─ sort by YDS    (state: sort=yds desc)
                 └─ player link -> /nfl/player/_/id/…   (node exists? edge : push)
```
The frontier held about 40,000 football states this build. Termination is a graph property: the
frontier is empty.

---

## 3. How "pixel to pixel" is actually done

1. **Snapshot the reference.** Playwright + Chrome DevTools protocol, 1440×900 at 2×, animations
   frozen, fonts loaded. Save the full page PNG, the hydrated DOM, every XHR body and a region box
   per module (`regions.json`).
2. **Measure, don't eyeball.** For each element: box, font family / size / weight / line-height,
   colours, padding, border, shadow, transform, transition (e.g. the strip cell measured 150×130,
   slide 0.2s ease-in-out, 1px rgb(203,204,206) divider).
3. **Build to the numbers**, then converge: diff the clone's computed styles per property against the
   reference and fix until equal or a declared ceiling (the ESPN font cannot be vendored).
4. **Pixel gate** (`PAGE COMPLETE`): clip each module on both sides and count differing pixels; masks
   for ads, video, live timestamps.

**Honest state today:** PAGE COMPLETE fails 166 modules. The main causes are:
- The reference moved on after the snapshot (T0 = 22 Sept), so the pages changed.
- The 300-image-file cap forces stand-in photos.
- Page length differs, which shifts the footers.

Most new football pages (QBR, team seasons, recap, game pages) have measured layouts but **no pixel
suite has been run on them yet**. Measurement-based building is done; pixel proof is not.

---

## 4. Tools

| Tool | Used for | State now |
|---|---|---|
| Playwright (headless Chromium) | Every capture, every measurement, every click comparison, on both sides | Used throughout |
| Claude in Chrome (your browser) | Quick live discovery: hovers, dropdown contents | **Not usable**: the VPN exits through <VPN exit> and espn.com returns a bot challenge. Switch to a US exit to re-enable it. |
| curl | Page JSON (`__espnfitt__`) and API responses | Used (the fastest capture path) |

---

## 5. Many agents at once: is it efficient? Partly.

**What was done this build.** The coordinator (me) plus six builders, each in its own git worktree,
own ports and own copy of the DB. The NCAAF builder added six helpers of its own.

**What worked.**
- Throughput: about 90 gaps were closed in one day.
- 35,000 reference pages were captured and 21,179 player pages built.

**What went wrong** (all fixed, all now rules):

| Problem | Cost | Rule now |
|---|---|---|
| A test was pointed at your server and deleted 3 favourites | Your data | The test refuses ports 3000/8000; QA runs on a separate stack |
| 3 builders chose the same migration id | Manual re-parenting ×3 | The coordinator assigns migration slots up front |
| 2 builders designed the same `section_page` table differently | One rebuilt onto the other | Shared contracts (tables, endpoints, components) are decided before builders start |
| The same FCS teams and stories were added twice with different ids | Dedupe at merge | Id ranges and one owner per table |
| Where To Watch and other ruled-out sections were built | Wasted work, discarded | Every briefed destination is checked against the rulings first |
| The usage limit stopped all builders twice | Hours lost | At most 3 builders, no helper agents |
| Your dev server served stale code after a large merge | A false "pass" I then re-ran | Restart the dev server after every big merge and re-check |
| Change-log triggers were lost by my reload script | The reset path would break | Triggers are restored only by the repo's sync script |

**Efficient design going forward:**
```
1. Coordinator: freeze contracts (schema, migration slot, id range, shared components) per area
2. Builders (≤3): own disjoint files, build + self-verify on their ports
3. QA stack (separate DB): regression + comparison runs, never the human's stack
4. Coordinator: merge one at a time -> full sweep -> QA pass -> push
```

---

## 6. Can this be used across an enterprise without blunders? Not yet, not 100%.

What makes it enterprise-grade today:
- Every commit runs gates: no literals, no personal data, images, nav parity, distinct crests, seed
  size, the migration round-trip, and render.
- Corrections become permanent checks.
- Work is isolated per worktree.

What still makes it unsafe:
- It trusts the builder's self-report until the coordinator re-checks.
- The pixel proof is incomplete.
- It needs a human to name a new class of mistake.

"Won't do any blunder" cannot be promised by any tool. What can be promised is that **every blunder
gets caught by a gate before it reaches the PR**. That is what the QA layer below is for.

---

## 7. The QA layer (to build next): replacing a human QA's eye

A human QA catches small visual and behavioural differences. Each item below becomes an automated
check, run on the QA stack against espn.com (structure and style) and the T0 capture (content):

| # | What a human QA notices | Automated check |
|---|---|---|
| 1 | "It looks off" | Per-module pixel diff at **1024 / 1440 / 1920**, same Chrome, masks only for data that legitimately differs |
| 2 | Wrong font, size, weight, colour, spacing by 1px | Computed-style diff per element (every property), tolerance 0 |
| 3 | Text cut off, wraps differently, ellipsis | Line count and overflow per text node, both sides |
| 4 | Misaligned by a pixel | Box x / y / w / h per element, tolerance 1px |
| 5 | Hover / focus / active looks wrong | `forcePseudoState` hover + focus on every interactive element, then the style diff |
| 6 | Disabled looks clickable (or shows a red bar) | Every disabled control: grey token, not-allowed cursor, no indicator |
| 7 | A dropdown has the wrong items | Open every menu and select; compare items and their order |
| 8 | A click goes somewhere else | Click every control on both sides; compare URL shape, content change and network call |
| 9 | Animation feels different | Sample frames at 0 / 100 / 200 / 300 / 700 ms; compare transform and opacity |
| 10 | Sticky / scroll behaviour | Scroll to 3 depths; compare what is pinned and the z-order |
| 11 | Keyboard and screen reader | Tab order and accessibility tree (role, name, state) diff |
| 12 | Empty, loading and error states | Force each (block an API response) and compare |
| 13 | Dates, times, numbers | Viewer-local time, formats (12-hour clock, "Tues", "18.0%") |
| 14 | Anything writes and persists | Round trip: write, reload, check every surface, undo |
| 15 | Console errors, broken images | Zero page errors, zero failed image loads |

**Output:** a findings list, each finding with a cropped reference|clone image pair, the property that
differs and a severity. Then fix, re-run, and repeat until zero unexplained differences. A difference
can only be accepted as a named ceiling (for example the ESPN font, the image cap, or T0 data drift),
never silently.

**The hard part, stated plainly:** the clone is frozen at 22 Sept and espn.com is live. So:
- structure and style are compared against live espn.com;
- content is compared against the T0 capture;
- data-dependent text is masked.

Otherwise every score would show up as a "difference".
