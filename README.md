# seemly

Give it a URL. It clones that page, everything on it, and everything reachable from it
into this repo as an RL environment: pixel for pixel, flow for flow, backend, database,
seed and reset included, with zero typed data and zero personal data. It asks one
question at the start, then runs unattended, and it learns from every correction you
give it.

## In one minute

```
seemly https://www.example.com/dashboard
```

1. It looks at the page for two to three minutes and prints one filled-in block
   (scope, depth, reach, login, edition, never-fire list, budget). You reply `go` or
   correct a line. That is the only question it asks.
2. It runs. You hear from it only at `BLOCKED` (do the one thing it names, reply
   `resume`), `SESSION CHECKPOINT` (fresh session, `seemly resume`), or `DONE`.
3. `STATUS` any time. `localhost:3000` shows the clone filling in.
4. Anything else you type mid-run is a correction: saved, applied, learned from.

Attach whatever helps in the same message: screenshots of states it might not reach, a
recording, a sentence about what matters, a login note, a budget. Nothing is required
beyond the URL.

## What it builds

- **Everything reachable by default.** The page, every control and state on it
  (pickers, tabs, dropdowns, modals, carousels, hover states), then every internal link
  under the URL's path prefix, recursively, until no unvisited surface remains. A root
  URL means the whole site. `DEPTH 1` or `DEPTH 0` narrows it.
- **The data layer.** Schema induced from captured payloads with the reference's own id
  formats and ordering; Pydantic, SQLAlchemy and TS mirroring each other; thin routers,
  service layer, linear migrations; `/api` mirroring the reference's requests;
  `POST /reset`, snapshot and restore, state introspection. Seed from capture only,
  byte-identical twice.
- **One shell, one module library, one page component.** Pages sharing a DOM skeleton
  are one template built once; every other page of it is configuration rows. League,
  section or page is a parameter, never a branch.
- **Verified three ways per element**: structure (DOM, role, name, text, href), style
  (every computed CSS property), pixels (per-module diff against an oracle frozen at
  capture time, masks for ads, video and live timestamps). Every click replayed on
  reference and clone and locked as a golden trace.

## How it works

| phase | tool | what happens |
|---|---|---|
| Preflight (10 min) | both | loads the target in Chrome and Playwright, compares edition and login state, checks repo, sets the 2-hour first-page deadline. Refuses to start if the two tools see different sites |
| Snapshot (15 min) | Playwright + CDP | all in-scope pages at one instant T0: hydrated DOM, every XHR body, every window global, images, fonts, computed styles, accessibility tree, full-page pixel oracle |
| Graph | Claude in Chrome | fires every control for real, pushes what opens onto a priority queue, dedupes by URL + DOM skeleton, clusters templates; new nodes captured as T0+n |
| Build | repo | per node: anatomy from capture, semantic skeleton, schema, backend, wire, all eight states, computed-style convergence to zero before "built", mount |
| Verify | both | structure, style, pixels per element; PAGE COMPLETE and MODAL COMPLETE tables; golden traces; a no-context reviewer per batch |
| QA passes | both | with a budget, re-walk everything until the clock runs out |
| Distill | local | turns corrections and lessons into rules, checks and eval cases |

Tool split by strength: Chrome (your real profile) for discovery and behaviour;
Playwright (persistent profile, writes to disk, CDP-only calls) for anything that must
be byte-exact. Both must reach the same edition; preflight enforces it.

## Seeding and schema: the practices it enforces

- **Schema comes from captured payloads, never from memory.** Every XHR body, every
  hydrated DOM section and every page global is a payload. Per endpoint it induces the
  request and response shape, status codes and error bodies, id format (numeric string,
  uuid, prefixed), ordering strategy (integer position, array order, fractional index),
  timestamp format and timezone, pagination shape. All matched exactly; a wrong id
  format leaks a learnable pattern to the agent being trained.
- **Pydantic, then SQLAlchemy, then TS**, mirroring each other; thin router, service
  layer, one migration per module in a linear chain with a working `downgrade()`;
  indexes on every FK and every filtered or sorted column.
- **Seed only from the capture** while the reference is reachable. No synthesis, no
  fixtures on a production path, no canned fallback. 12 items rendered means those 12
  seeded. Row-count parity is checked per module: reference = seed = endpoint.
- **Determinism**: seeded RNG, frozen clock at T0, stable ids in the reference's format,
  seeded through the service layer, reset and seed twice byte-identical, `POST /reset`
  idempotent, snapshot restores byte-identically, state contract regenerated and never
  hand-edited. Baseline seed and scenario seeds kept separate.
- **Always-present tables**: `page`, `page_module`, `nav_item`, `ui_copy`, `asset`, plus
  whatever the payloads force. Every column a surface reads is written by something.
- **Scrub before store**: identity keys and values (emails inside payload bodies
  included), then a personal-detail grep after every page. A hit stops the capture.

## Tools: which one, for what, and why that is the efficient choice

| tool | used for | why it is efficient there |
|---|---|---|
| **Claude in Chrome** (extension, your real profile) | discovery: hover every nav item, open every dropdown, picker, tab, modal, carousel; read what opened; confirm a redirect or edition; replay a click on the clone; redact-then-shoot screenshots when signed in | no capture run burned per question; sees the hydrated UI as a user does; already has your session and VPN; reading the DOM or running JS is one call |
| **Playwright** (persistent profile) | the T0 snapshot of all pages, every capture to disk, the pixel oracle, the pixel diff, step 8 style convergence, the app-renders gate | the only tool that writes files; Chrome MCP truncates near 1 KB per string and 100 items per array, so a 1 MB DOM through it is about 1,000 round trips against one write |
| **CDP** (through Playwright) | `DOMSnapshot` with the full computed-style manifest, `getFullAXTree`, `forcePseudoState` for hover and focus, `getPlatformFontsForNode`, `getResponseBody`, `Debugger.getScriptSource`, coverage, `Input.dispatchMouseEvent` at box-model centres, full-page screenshots under the determinism lock | none of these exist in Chrome MCP; they turn "renders" into "matches": about 120 CSS properties per element diffed as expected vs got, same Chrome build on both sides |

How it keeps the tools efficient, not merely used:

- **Preflight refuses to start** unless both tools reach the same edition and login state.
- **One snapshot instant** for all pages (about 15 minutes) instead of page by page over hours.
- **Discovery and build overlap**: Chrome expands the graph while Playwright captures new
  nodes and the shell builds from the snapshot.
- **Templates, not pages**: nodes with the same DOM skeleton are captured for style once
  and built once; 300 game pages cost one template plus configuration rows.
- **Clips cropped from the full-page oracle**, never re-shot per module.
- **Every crossing logged**: a Playwright use during discovery or a Chrome use during
  capture needs a row in `tool-fallbacks.md` with the reason.
- **Gates start their own instances** on free ports; nothing trusts a stale server.
- **Convergence rounds predicted vs actual** per node; a rising trend halts the node and
  writes a lesson, so a misused tool shows up as a number.

Details: `reference/tool-split.md` (with the eight known Chrome MCP limitations and the
workaround for each), `reference/backend.md`, `reference/capture-rules.md`.

## The words

| word | effect |
|---|---|
| `go` | confirm the intake block, start |
| `resume` / `seemly resume` | continue after BLOCKED, or in a fresh session after a checkpoint |
| `done` | you finished a manual step (login, VPN) in the window it opened |
| `STATUS` | six-line position report, keeps running |
| `STOP` | the only halt; finishes the atomic step, writes RESUME.md |
| `distill` | run the learning step now (also automatic at checkpoints and DONE) |
| `promote` | move chosen local learnings into the team skill as a branch for PR |

Everything else is a correction. Case matters only for `STATUS` and `STOP`.

## What stays local, what is shared

| what | where | pushed? |
|---|---|---|
| the skill (team base) | `.claude/skills/seemly/` | yes, via PR |
| corrections, lessons, overlay rules, scorecard history | `never_to_be_pushed/seemly-local/` | never |
| discovery, captures, resume state | `never_to_be_pushed/discovery/` | never |
| the clone | `frontend/ backend/ scripts/ e2e/ docs/` | yes, on `feat/*` |

Overlay rules win over the base. `promote` is how a rule you taught it becomes a team
default; corrections themselves are never shared.

## Files in this folder

| file | read it when |
|---|---|
| `SKILL.md` | the procedure; Claude Code loads it |
| `INTAKE.md` | you want to know what to type or attach |
| `TEAM.md` | onboarding a teammate |
| `distill.md` | how learning works |
| `reference/decisions.md` | every default; the answer to "why did it do X" |
| `reference/graph.md` | how exploration order and reuse are decided |
| `reference/tool-split.md` | why Chrome here and Playwright there |
| `reference/capture-rules.md` | what the snapshot must contain and the filters it must never use |
| `reference/checks.md` | the 21 gates that run on every commit |
| `reference/backend.md` | the data-layer contract |
| `reference/principles.md` | every lesson so far, stated for any site |
| `reference/defects.md` | the defect catalogue |
| `reference/method/` | the base method (RL_BUILD, RECON, BUILD_PROTOCOL, SELF_CORRECTION) |
| `scripts/` | working gates and capture tools from the first build |
| `templates/` | RESUME and SCORECARD shapes |
| `corrections/2026-09-22-espn/` | the founding build: 27 corrections and what each became |
| `evals/cases.md` | 24 failure cases a change must not regress |

## Requirements

Claude Code with the Claude in Chrome extension connected; Node 20+; Python 3.11+;
Playwright (installed at first preflight if missing); a VPN both tools can use if the
target geo-routes. The repo's `AGENTS.md` wins on stack and conventions.

## Accuracy

Measured, never claimed: `templates/SCORECARD.md` is filled at every DONE with
provenance, pixel parity per module, structure and style pass rates, human
interventions, time to first page, convergence-rounds trend. The previous build's column
is the bar the next one must beat. Founding baseline (ESPN, Sept 2026): 8,204 / 8,204
text nodes traced, ~15 interventions, ~6h to first page. Targets: 100%, under 3, under 2h.
