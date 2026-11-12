---
name: seemly
description: Clone a live web app (a page, a feature, or the whole app) into an RL environment repo, pixel for pixel and flow for flow. Use for any request like "clone <url>", "recreate <site> as an RL environment", "pixel-perfect copy of <page>", "resume the <site> clone build", "run qa" or a bug sheet to work through, "distill" after a build, or "use consensus thinking" to settle PR conflicts, an error or a critical decision with a judged multi-agent panel. Uses Claude in Chrome for discovery and Playwright + CDP for capture, mirrors backend, database and network from captured payloads, renders zero typed data and zero personal data, verifies every element three ways, and rewrites its own rules from the corrections it receives. Not for ordinary browsing, scraping for analysis, or building a site from a design.
---

# seemly

You are about to clone a real web app into this repo so agents can be trained on it. The
clone must match the reference in four channels (pixels, DOM and accessibility tree,
network, store), render only data captured from the reference, contain no personal
data, and expose every flow the reference has. You do this without asking questions
and without stopping, except where this file says a stop is allowed.

`AGENTS.md` in the repo wins over this skill on stack and conventions. This skill wins on
process. The reference files under `reference/` are part of this skill and are read
when this file points at them. The full base method is bundled under
`reference/method/` (`RL_BUILD.prompt.md`, `RECON.prompt.md`, `BUILD_PROTOCOL.md`,
`SELF_CORRECTION.md`); this file is the executive layer on top of it, and where the two
disagree this file wins. On the first run in a repo, copy `reference/method/BUILD_PROTOCOL.md`
to `docs/BUILD_PROTOCOL.md` if absent (and add a must-read pointer to it at the top of the
repo's `AGENTS.md` detailed references), and `scripts/` templates to the repo's `scripts/`
(section 7). The orchestrator and the QA scripts run from the skill itself and load Playwright
from the repo (`pnpm add -D -w playwright` there if it is missing). `reference/backend.md` is the data-layer contract; `templates/` hold the
RESUME and SCORECARD shapes.

---

## 0. The no-stop contract (this paragraph outranks everything below it)

You are turn-based: when you finish a message to the human, the run is dead until they
type. So you write to the human in exactly four cases, and no others:

1. `PREFLIGHT FAILED` with the one thing to fix (section 1).
2. `BLOCKED` for one of three reasons only: an irreversible or paid action is about to
   fire (including the first write of each kind on the reference, section 4); a
   credential or account you do not have; the environment changed under you (edition,
   login state, VPN). Print the block from section 9 and wait for `resume`.
3. `SESSION CHECKPOINT` when context runs low: finish the atomic step, write
   `discovery/RESUME.md`, print the one resume line, stop.
4. `DONE` with the final report (section 10).

Everything else you would have said, slice reports, findings, caveats, push state, goes
into `discovery/RESUME.md` and `discovery/LESSONS.md`. Decisions you need come from
`reference/decisions.md`; if it is silent, take the conservative option, write one row in
`discovery/ASSUMPTIONS.md`, continue. A critical call (scope, unbounded work, server-side
logic) during a build goes to the decision panel in `reference/panel.md` instead:
three independent agents, a judge, escalation only on its listed triggers. PR conflicts and
errors go to the panel only when the human asks for consensus thinking. Never ask. Never report progress. Never wait for a
push approval: push to the `feat/*` branch yourself after every slice, never to main,
never open PRs.

Control words, and only these, are commands: `resume`, `done`, `approved`, `STATUS`
(print the six-line block from section 9, keep working), `STOP` (finish the atomic step,
halt), `distill`, `promote`. **Every other message the human sends mid-run is a
correction.** Before acting on it: save it verbatim to
`LOCAL/corrections/<build>/<nn>.md` with the phase and step it arrived at, append the
same to `discovery/NOTES.md`, then apply it from the next step and keep working. The
human never has to prefix anything; the fact that they had to type is the signal.

`LOCAL` = `never_to_be_pushed/seemly-local/` in the current repo, created on first
run. It is git-excluded: the **inbox** for everything the skill learns on this machine,
written the same day and moved into the tracked skill by `promote` (the human ordered all of
it promoted on 2026-09-29; see "Learning location" in `reference/decisions.md`). It holds: `corrections/`, `overlay/decisions.md`, `overlay/checks.md`,
`overlay/capture-rules.md`, `overlay/principles.md`, `overlay/defects.md`,
`evals/cases-local.md`, and `SCORECARD-history.md`. Overlay files have the same shape
as their `reference/` counterparts and **win over them** wherever the two disagree. Read
the overlay right after the base reference, every session.

---

## 0.5 Intake

The human's message follows `INTAKE.md`. Two forms:

**URL, plus anything** (`seemly <url>` with any attachments or free text): the URL is
a complete request with full defaults (DEPTH all under its prefix, MAXIMUM fidelity,
run to DONE). Attachments and free text are `GIVEN`: screenshots become the shot list,
recordings become traces to replay, sentences become REACH, KNOWN, NEVER or BUDGET by
their content. Then spend at most three minutes in Chrome on that page: count
modules and their signatures, list the controls that open something on the page, list
outgoing link prefixes with counts, check login state and edition. Print the single
inferred INTAKE block from `INTAKE.md` with every field filled, guesses marked
`[inferred]`, defaults `[default]`, and ask exactly one thing: `go`, or corrections.
On `go` (or after applying corrections) the run is unattended. This is the only question
seemly asks in a build. Do not print it again on resume.

**Fields given**: `TARGET` and `SCOPE` are required, every other
field defaults from `reference/decisions.md`; no echo block, start preflight directly. `DEPTH` defaults to **all under the
target's own path prefix**: every internal link under the prefix is followed and its
destination becomes a full node, recursively, until the frontier is empty. A root URL
means the whole same-origin site. `1 under <prefix>` and `0` narrow it. Links outside
the prefix and external links are real hrefs to the standard out-of-scope page with a
GAP row each. States named in `REACH` are states
of the page captured at T0, never a different T0. Parse it, echo it once inside the
preflight block as `INTAKE: <fields, defaults marked>`, never ask for a missing field.
`seemly resume` means: read `discovery/LESSONS.md`, then `discovery/RESUME.md`, print
`RESUMED FROM: <phase>.<step>`, continue. `distill` means run `distill.md`.

This skill is site-agnostic. Nothing in `SKILL.md` or `reference/` names a target;
target-specific facts live only in the build's `discovery/` and in
`corrections/<build>/`. Scripts under `scripts/` carry constants from earlier builds
that are replaced on first run (see `scripts/README.md`). Apps that need login use the
headed persistent profile and a manual login, per `reference/tool-split.md`; multi-role
apps capture one session per role and record roles with no login as unreachable.

## 1. Preflight: ten minutes that decide whether the run can work

Run every check by actually doing it. Print the block. A ✗ on a required row prints
`PREFLIGHT FAILED` with the fix and stops; that is the one place a stop is cheap.

```
PREFLIGHT
  target reachable      ✓ <final URL, title>              | ✗ <status / bot wall / redirect>
  edition               ✓ <edition> in Chrome AND Playwright | ✗ Chrome=<x> Playwright=<y>
  login state           ✓ <logged out | logged in, ruling: reference/decisions.md#account>
  chrome MCP            ✓ tabs_context ok, <n> tabs      | ✗ absent
  playwright + CDP      ✓ <version>, Browser.getVersion ok | ✗
  write to disk         ✓ discovery/ created, exclude guard set | ✗
  repo                  ✓ AGENTS.md read, stack <x>, verify.sh present | ✗
  push guard            ✓ pre-push refuses without PUSH_OK=1 | ✗ installed now
  theme                 ✓ <theme> asserted by value in both tools (edition_gate) | ✗
  first-page deadline   set: <now + 2h>
```

Rules the preflight enforces, learned the hard way:
- **Both tools must reach the same edition and the same login state.** If the reference
  geo-routes and only one tool has the VPN, stop here and say which tool needs it. Do not
  design around it.
- **Playwright uses a persistent profile** under `discovery/pw-profile/` (excluded from
  git). If a VPN extension or a manual login is needed, launch it headed once, print
  `WINDOW OPEN, waiting`, let the human act, continue on `done`. Never script a login.
- **Never trust a server already on the dev port.** Every check that renders the app
  starts its own instance on a free port.
- **Exclude guard**: `discovery/`, `pw-profile/`, screenshots and every capture live under
  `never_to_be_pushed/` which is in `.git/info/exclude`, never `.gitignore`. Nothing
  under it is ever staged.

---

## 2. Tool split, by strength, not by preference

| job | tool | why |
|---|---|---|
| Discover: what opens on hover or click, dropdown contents, tabs, modals, carousels, the click tree, "is this a GAP or did I miss it" | **Claude in Chrome** | real profile, hydrated UI, cheap to poke, no capture run burned |
| Capture to disk: hydrated DOM, every XHR body, every `window.*` global, images, fonts, computed-style manifest, AX tree, full-page oracle under the determinism lock | **Playwright + CDP** | writes files, byte-exact, `DOMSnapshot`, `forcePseudoState`, `getPlatformFontsForNode`, `Input.dispatch*` have no Chrome MCP equivalent |
| Walk the click graph: fire every element, record what opened, save each node's capture | **the orchestrator** (Playwright, persistent profile, writes aborted) | mechanical, resumable, never skips a control out of boredom |
| Re-check a behaviour, confirm a redirect, verify a doubt on the live site, everything the walker cannot fire (drag, drawing, typing, uploads) | Claude in Chrome | |
| Capture a write flow a person performs (approve, submit, sign off, a setting) with every call's request and response body, tied to the click | **`capture/record-session.mjs`** (headed, saved login, the person drives) | the only way to get a real write's shape without the tool firing it |
| Reference API vs the clone's OpenAPI: endpoints not served, request and response fields that differ | **`qa/api_diff.mjs`** | network mirroring checked from the captures, offline |
| Pixel diff oracle vs clone | Playwright over CDP, **one Chrome build for both sides** | same renderer or the diff is noise |
| Anything Chrome MCP returns truncated (strings over ~1 KB, arrays over ~100 items) | Playwright | Chrome MCP cannot write files and truncates; do not chunk a 1 MB DOM through it |

Every Playwright use during discovery outside the orchestrator, and every Chrome use during
capture, gets a row in `discovery/tool-fallbacks.md` with the reason. See `reference/tool-split.md` for the
known limitations of each tool and the workaround for each.

---

## 3. Phase A: snapshot everything at one instant (Playwright, target 15 minutes)

Consistency needs one instant. All in-scope pages are captured in one continuous run
at **T0**, and every later addition is `T0+n`, masked for drift in the pixel oracle.

Capture rules (`reference/capture-rules.md` has the full list; these are the ones that
were violated last time):
- **Block nothing first-party.** Block ads and analytics only, by an explicit host
  list, and log every blocked request with its reason. A "third party" that bootstraps
  the site's own auth or data gates real content.
- **Globals by deny-list, never allow-pattern.** Capture every enumerable `window`
  property that is an object, minus browser built-ins. A filter like `startsWith('__')`
  defines the evidence base by accident.
- **The hydrated DOM is a source**, often the primary one for server-rendered sites.
  Save it at rest and after the scroll pass. Nav, footer, strips and anything marked
  server-rendered are seeded from it with provenance `html-hydrated`.
- **Every visible text node** with its module path: the provenance target.
- **Every image and font binary** by hash, with a manifest to the original path.
- **Pixel oracle, whole page**: full-page PNG at the canonical viewport (1440x900 @2 by
  default) under the lock, plus `regions.json` with the box of every module **including
  header, sub-nav, strips, every column, every promo, footer and legal block**, and mask
  classes for ads, video posters, live timestamps, personalised modules. Any pixel of
  the page not inside a listed region is an oracle defect, not something to skip.
- **Hover and focus oracle** via `CSS.forcePseudoState` on every interactive element.
- **Scrub at capture time**: personalisation keys and values (identity, emails, cookies,
  ids), logged in `scrub-log.jsonl`. Personal-detail grep over the tree after every page.

Before the first capture and before every later one, run the **edition gate**
(`scripts/qa/edition_gate.mjs`; it prints a probe to run in Chrome and compares both readings)
and print its result to the human: both tools on the reference host, served the target
edition, in the login state the target needs, theme and language asserted by value. A UI kit
may keep the theme in `localStorage`; seed it in the persistent profile.

Then provenance: every text node resolves to a captured field, a formatted value, or a
`ui_copy` row. **Unresolved must be 0.** A `NOT CAPTURED` verdict for any module must
cite an allowed request that returned empty, never a merely missing payload.

Then the seed: induce the model from the payloads, keep the reference's id formats and
ordering, seed through the service layer, `POST /reset`, snapshot and restore, **byte-
identical twice**. Nothing synthesised while the reference is reachable.

Before any write of a metered kind (one that spends a credit, token or quota), the full style,
AX and oracle capture of every step behind it runs first: the write may be possible once.

---

## 4. Phase B: walk the surface graph (the orchestrator walks; you rule)

**Time-boxed reference (a sandbox, a trial, a training tenant):** follow `reference/sandbox.md`.
It orders this phase so connected time goes only to capture: a pilot to tune the walker
(`--read-posts auto`, `--pace`, `--relogin-wait`), a read walk per role, people-driven write
sessions through `capture/record-session.mjs`, then everything else offline.

The app is a directed graph of surfaces and states. `reference/graph.md` is the algorithm and
`scripts/orchestrator/` runs it: node identity by URL plus structural signature, templates by
signature similarity (one template = one component, every later node of it = configuration
rows), a priority queue (entry nodes, then the most-linked template, then shallower, then
cheaper, writes last), dedupe by node id, cheapest replay routes (Dijkstra, never through a
write), STATE_BOUND (30 per path family or query parameter, the rest recorded out of range),
and termination as a graph property. `discovery/graph.json` is the queue and the single source
for STATUS, PAGE COMPLETE and the scorecard. `O` below is
`node <skill>/scripts/orchestrator/run.mjs`, run from the repo root.

```bash
O init --target <url> [--prefix /path] [--entry <url>]...   # entry pages, read in the persistent profile
O explore --max-nodes 40                                      # one chunk; repeat until it prints CLOSED
O status    O tree    O live    O pending    O route <node>   # STATUS, tree.md, graph.html, writes waiting
```

Run `explore` with `run_in_background` and keep building while it walks; each chunk saves the
graph, so a crash or a checkpoint loses nothing. How to run it well, learned on a full audit:

- **Logged-in reference:** the human logs in once in a headed window (`--remote-debugging-port`);
  copy that login out with `node <skill>/scripts/lib/export-login.mjs --cdp <port url> --domain
  <site> --out never_to_be_pushed/discovery/auth-ref.json` and run every tool with
  `SEEMLY_STORAGE_STATE=<that file>`, so each gets its own browser. Never attach two tools to
  one window over CDP: a site's service worker trips a Playwright assertion in every attached
  client and kills it.
- **Parallel workers:** copy `graph.json` into one dir per area and run
  `O explore --dir <copy> --only-prefix /area ...` per worker; each walks only its area.
- **Stop and recover:** a SIGTERM stops a walk cleanly (the node in hand goes back on the
  frontier). If a walk ever died with its browser, `O requeue --failed` restores its give-ups.
  Nodes reachable only through a write close as `bounded`, not as failures.
- **The clone side** is walked on an isolated copy (own DB copy, own ports, never the dev DB:
  a copy-on-write clone deleted when the walk ends, per the Storage section of
  `video/SKILL.md`, which binds every seemly test run) with `--allow-post '.*'`, so every write flow runs end to end; `errors.jsonl` then lists each
  failed API call and script error with the click that caused it.
- **The gap list:** `O compare --ref <ref dirs> --clone <clone dirs> --out graph-diff.md` matches
  views by path family and controls by normalised label, compares the shell once, and lists per
  view what the clone does not render, disables, leaves dead, or never opens. It is a candidate
  list: confirm each line by hand before it goes in a report.

Per node it replays the cheapest route, closes
any overlay open on load (recorded as its own node), saves `nodes/<id>/` (screenshot, DOM, AX
tree, every JSON read, `inventory.json` with what each element did), then fires every element
once: links are read in a side tab, buttons are clicked, popup triggers hovered, and what opened
becomes a node (page, modal, menu, in-place state) with an edge. Rows past STATE_BOUND are
sampled while they keep leading to the same template; shell controls are expanded on two
templates, then inherited. Disabled controls, text fields and selects are inventoried, not fired.

Safety is mechanical (`scripts/orchestrator/safety.mjs`): session-ending names are never
clicked; money, messaging, deletion and metered (credit, token) names are queued in
`pending-writes.jsonl` instead (`--risky probe` clicks them too); and every non-read request
is aborted in the browser, so a control that writes anyway shows its failure path and is
queued with the request it tried. A search or report that POSTs a read is allowed with
`--allow-post <regex>` after you have read its row. `explore` exiting 3 means the login was lost:
print `BLOCKED` (environment changed).

You keep the judgment the walker cannot make, in Claude in Chrome:
- every row of `pending-writes.jsonl` that the build needs is a write to capture: **the first
  write of each kind on the reference is a `BLOCKED` (irreversible action)**. Restoring a write
  usually means deleting it or reverting an account setting, which is exactly what NEVER
  forbids, and this runs unattended on the human's real account. So before it fires, print the
  block naming the write and its restore, and wait. A bare `resume` authorises that write and a
  restore that needs **no delete** (toggle back, unfollow, edit back to the state recorded in
  `DIRTIED.md`). A restore that needs a delete is not fired on a bare `resume`: the block says
  so, and only a reply naming that delete (`resume, allow delete: <what>`) authorises it, for a
  row this run created, recorded in `DIRTIED.md`. Nothing authorises deleting or changing
  anything the run did not create. A metered write is authorised for the exact price and kind
  shown; anything else re-blocks.
- what the walker cannot fire: drag, drawing on a map or canvas, typed input and its validation
  (the QA battery), uploads, keyboard shortcuts, states behind a write. Explore them in Chrome,
  then `O requeue <node>` or `O gap <node> --reason "..."`;
- a node whose skeleton says "sample" (a demo record that fires no data request) stays open
  until a real instance's requests are captured;
- **negative verdicts are evidenced on every in-scope page**, never from one;
- new content the T0 snapshot lacks is captured by Playwright as `T0+n`.

Nothing is terminal because it "probably has nothing behind it": the queue decides. The walk is
done when `O explore` prints `CLOSED` and `O tree` writes `discovery/tree.md` with a verdict per
node; `bounded` and `gap` nodes are closed with their reason recorded, and nothing is capped
without one (a human ruling, an irreversible or paid lane, a blocked third party).

---

## 5. Phase C: build unit by unit, in the graph's order

```bash
O plan                 # refuses while the graph is open; units: shell, module archetypes, templates
O next-unit            # claims the next unit whose deps are built, writes discovery/packets/<unit>.md
O unit-done <unit> [--verified]
```

The packet is the whole brief for one unit: the members (one component, every other member is
configuration rows), the capture dirs to build from, what every control must open, the replay
route of each member (golden traces start there), the writes on it, and the lessons the
learning store selects for it. A unit can go to a subagent with the packet as its prompt (one
agent per unit, never two on one template); the unit is not done until its verification below
has run. The order is the RL_BUILD slice logic made mechanical: environment endpoints and
baseline seed first, then the **shell built once as a layout**, then module archetypes
most-shared first, then templates, every page after the first as **configuration rows only**.

Per unit, in this order, none skipped:
1. Anatomy from the capture (what is a drawer vs a modal, what nests where).
2. Semantic skeleton (real buttons, links, landmarks, labels), matching `aria.yml`.
3. Schema and backend (Pydantic first, thin router, service, migration, OpenAPI
   metadata; every write satisfies W1 to W6 in `docs/BUILD_PROTOCOL.md`).
4. Wire through `/api`, every query param in the key.
5. All eight states from the inventory, not the happy path.
6. **Computed-style convergence**: diff the full manifest per element against the capture,
   emit per-property instructions (expected vs got), converge to zero or a declared ceiling
   with a reason. Nothing is "built" before this.
7. Mount it. A component not imported by the page or the shell is dead code.
8. **Wire it.** A write control ships with its round trip (`scripts/qa/write_roundtrip.mjs`,
   one spec row per write, every surface that reads it in `expect`) in the same change.
   Server-rule fuzzing and order dependence run inside the unit that adds a write or a
   filtered read, never as a closing pass. Anything rendered is interactive: if a write needs a
   row the seed lacks, derive it from captured fields; otherwise do not render the thing.
9. **Human-eye pass** (`scripts/qa/human_eye.mjs`, `--dead-controls` at unit end): no shared
   stand-in image, no clipped text, no unnamed control, no enabled control that leads nowhere.
   A finding blocks done.

Reuse contract, gate-enforced:
- one component per module archetype, one row each in `frontend/components/modules/REGISTRY.md`;
- the page's variant is a prop or a `page_module.params` value, **never a branch on a
  page or league key**, never a per-page file;
- one page component, one shell layout, for every route;
- members after the first land as configuration rows with **0 component files changed**;
  a non-zero count goes back to the module library. A member judged a configuration row by a
  coarse (role, label) match is inherited-unverified until its per-control style diff passes.

Milestone: **the first page renders real data at localhost within 2 hours of preflight.**
If it will not, write why into `RESUME.md` and keep going; the deadline is a signal, not
a stop.

---

## 6. Phase D: verify three ways, every element, every click

For every element on every page, before it is done:
1. **Structure**: DOM path, role, accessible name, text, href: clone equals reference,
   read from both sides.
2. **Style**: the computed-style manifest per property: equal, or a declared ceiling.
3. **Pixels**: the module's oracle clip vs the same module on the clone, same Chrome
   build, same viewport and DPR, same lock, masks applied: 0 differing pixels.

4. **Widths**: the width sweep (`scripts/qa/width_sweep.mjs`, 1024 to 2560 plus N-1 / N / N+1
   at breakpoints) and the structural label audit (`scripts/qa/struct_audit.mjs`): no invented
   or missing bar item, heading, table header or button at any width.

The five QA scripts (`scripts/qa/`, each writes its check record; each is proven by eval
`X-QA` to fail on its defect), plus `frame_diff.mjs` for video-mode builds (eval `X-FRAME`), and when they run, so they cost what they are worth:

| script | catches | cost | runs |
|---|---|---|---|
| `edition_gate.mjs` | Playwright on another edition, logged out, other theme or language than Chrome | seconds | preflight and before every capture |
| `struct_audit.mjs` | invented or missing nav item, heading, tab, button, column header, field label | 2 loads a page | unit end, per member |
| `human_eye.mjs` | stand-in images, broken images, clipped text, unnamed controls, sideways overflow; dead controls with `--dead-controls` | seconds; a reload per control with the flag | unit end |
| `write_roundtrip.mjs` | a write that answers 200 and never lands on a read or survives a reload | seconds a write | every unit with a write |
| `width_sweep.mjs` | overflow and layout that break away from 1440 | 2 loads per width a page | PAGE COMPLETE and QA |
| `frame_diff.mjs` | video mode, reference unreachable: a label the frame shows and the clone lacks, a region off by more than 4 px (atom) or 8 px (region), a role, count or order that differs from the spec | one load and two OCR passes a state | every state in `states.json`, unit end |

**Verify against frames (video mode).** Video mode's pipeline is `/seemly-video` (`video/SKILL.md`). When the reference cannot be reached and a recording
is the only truth (RL_BUILD §0.7), the pixel oracle and the two-tab compare have nothing to
open. `scripts/qa/frame_diff.mjs --plan discovery/frame_verify.json` takes their place for those
states: it drives the clone to each state of the video mode's `states.json` at the calibrated
viewport (100% zoom, DPR 1), screenshots it, and compares it with the state's canonical (masked)
frame on three channels: **text** (OCR both the same way; every frame label must be on the
clone; seeded values are ignored), **layout** (matched OCR word boxes; median offset per region
after calibration, 4 px atoms, 8 px regions, side-by-side crops on failure) and **structure**
(spec roles, names, counts and order against the clone's accessibility tree). Colour is never
judged from a frame; tokens come from a live capture when one exists. Output:
`discovery/verify/<state>.md` and `summary.json` (pass per checklist id, which the project's
coverage report shows as "built and verified"). Proven by eval `X-FRAME`. Reachable references
keep the pixel and two-tab paths above; frame_diff never replaces them.

Each is a row in `discovery/crosscheck.md`. "Matched at rest at one width" is a partial
verdict and is written as one. `PAGE COMPLETE` per route prints the table
page × module → pixels differing and fails on any unmasked module above 0 or any oracle
region with no clone module under it. `MODAL COMPLETE` does the same per modal state.

For every row in `queue.jsonl`: perform the same input on reference and clone, compare
what opened, changed, or navigated. Golden trace per page and per write under `e2e/`.

Then a **fresh-eyes review**: a subagent with no build context, only the capture, the
diff, `docs/BUILD_PROTOCOL.md` and `LESSONS.md`, instructed to report every disagreement
and fix nothing. Every finding is fixed or refuted in one line. Gate-weakening findings
are fixed immediately; the rest are pinned to a slice in `RESUME.md` with a release
condition.

---

## 7. Gates that run on every commit (`reference/checks.md` has each one's spec)

no-literal (dictionary + AST JSX text) · personal-detail grep · single-definition rule
for every exclusion selector · every registered component mounted · app renders on a
free port with the measured header height · negative surface verdicts evidenced on all
pages · state schema regenerated and unchanged · migration downgrade/upgrade round-trip
on a populated copy · push guard · every deferral carries a release check re-tested at
each pre-slice block · PAGE COMPLETE and MODAL COMPLETE in the full sweep.

A gate that exits 0 when it checked nothing is a defect: every gate writes `ran: true`
and a count, and the sweep reads those, not exit codes.

---

## 8. Learning inside the run (`SELF_CORRECTION` rules, applied)

Six triggers write a row to `discovery/LESSONS.md`: a verify failure, more than 5
convergence rounds, a gate catch, a human correction, a wrong assumption, a near-miss.
Every row becomes a check (T1 grep or lint, T2 trace assertion, T3 printed checklist as a
last resort with a reason). Open lessons block the next slice. Rounds predicted vs
actual are printed per slice; a rising trend halts the slice and writes a lesson. Seen
three times, a lesson is promoted into `docs/BUILD_PROTOCOL.md` in the same change.

---

## 9. Blocks you print

```
BLOCKED at <phase>.<step>
WHAT      <one line>
WHY       <one line, one of: irreversible action | missing credential | environment changed>
NEED      <the one thing the human must do>
RESUME    say "resume"
```

```
STATUS
  PHASE        preflight | snapshot | tree | build | verify | qa-pass-<n>   step: <x>
  DONE         <artifacts with counts>
  DOING        <one line>
  BLOCKED      <blocker or none>
  VISIBLE      <what localhost shows right now, one line>
  NEXT         nothing, keep running | <the one line to send>
```

---

## 10. Done, and after done

`DONE` is printed only when: `O status` shows the graph CLOSED and every unit built or
verified, with nothing capped without a recorded reason (`bounded` nodes count as closed,
their limits recorded); provenance is
100 percent; every route passes PAGE COMPLETE and every modal MODAL COMPLETE; every
golden trace is clean on four channels; the reuse table shows 0 component changes on
pages after the first; all gates green; the corpus record and its "what the method got
wrong" section are written to `../rl_components/rl-corpus/`; and
`corrections/<build>/SCORECARD.md` is filled from `templates/SCORECARD.md` with every
metric measured, not estimated. The scorecard is the skill's accuracy for this build,
and the next build must beat its previous column.

If the human gave a time budget, `DONE` is not the end: start QA pass 2, re-walk every
page and every click, fix every delta, pass 3, until the budget is spent. Every QA pass runs
`reference/qa-mode.md` (section 12). Each pass
prints its delta table into `RESUME.md`.

Then run `distill.md` (section 11) before the final report.

---

## 11. The skill improves itself: corrections, distill, promote

This is the learning loop and it runs without being asked.

**Capture** (automatic, section 0): every non-command message from the human is a
correction, saved verbatim to `LOCAL/corrections/<build>/` before it is applied. Every
`LESSONS.md` row is copied there at each checkpoint.

**Distill** (automatic at every `SESSION CHECKPOINT` and at `DONE`, and on the word
`distill`): run `distill.md`. It reads the build's corrections and lessons and writes
the result into `LOCAL/overlay/` first: a decisions row for every ruling the human had
to give, a check for every defect class, a capture rule for every capture hole, a
principle for every lesson that generalises, an eval case for every failure that could
recur. It never edits the tracked skill under `.claude/skills/` and never weakens a
check. It appends the build's scorecard to `LOCAL/SCORECARD-history.md` and prints a
diff of the overlay so the human sees what was learned. Nothing is committed.

**Promote** (on the word `promote`, or when the human orders learning into the skill): the
human chooses which overlay rows become team defaults, or all of them. The skill copies those rows into the tracked
`reference/` files with their origin, runs the eval cases, and prepares one commit on a
`feat/seemly-learnings-<date>` branch for the human to push and PR. Rules are
generalised (no target named in `SKILL.md` or `reference/`); the build's own correction
records go to `corrections/<build>/` with personal data scrubbed, as the founding build's do.
The team's copy learns what the human decides to share; the local copy learns everything first.

**Precedence when reading rules**: `LOCAL/overlay/` > `reference/` > `reference/method/`.
A resumed session prints `LOCAL: <n> corrections, <n> overlay rows loaded` in its
`RESUMED FROM` line.

The builds this skill learned from are recorded in `corrections/` inside the skill, one
dated folder per build (the earliest is the founding example; the newest bug-sheet build is
the QA mode's source), plus the overlay snapshot they were distilled from
(`corrections/_overlay-2026-09-29/`) and `corrections/SCORECARD-history.md`. Their rules live in `reference/`. Read `principles.md` before any preflight; every rule
above that sounds oddly specific came from there.

---

## 12. QA mode: `run qa`, or a bug sheet

On `run qa`, a QA pass after `DONE`, or a bug sheet / ticket list from the human, follow
`reference/qa-mode.md`: read each row and every attachment (an unreadable attachment blocks
its own row, marked `BLOCKED` in the batch table, while unrelated rows go on; it is not a
run-level `BLOCKED`), classify with evidence, establish account state on both sides, capture the
reference fresh in every state the probe catalogue names, diff, fix at the source, verify in
the rendered page, record, and print the batch table. **"Fixed" has one meaning**: the
tester's path replayed click by click on both sides in the same state, and the whole touched
surface diffed side by side with a reference page in the same state class. A symptom proven
through the API, a matching static look, or a fix checked against the row's title is not
fixed, and is never reported as fixed. Run the whole probe catalogue on each
component a row touches, not only the reported symptom. Every defect the human or a tester
reports that no probe would have caught adds a probe row the same day: the next build's QA
must catch it before a tester does.

