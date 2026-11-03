# Build Protocol — how a surface gets built without a second pass

**Read this before building or changing any UI surface.** `AGENTS.md` says *what the
rules are*; this says *in what order to do the work* so the rules are satisfied on the
first attempt instead of being restored by a follow-up `fix:` commit.

Every rule below exists because the failure it prevents **already happened in this
repo**. The *Defect Catalogue* at the end names the commit for each one. That is the
point of the document: the corrections stop being prompts the developer has to re-type
each session and become a procedure the agent runs itself.

> **Scope.** One *surface* = one route, or one thing a click opens (drawer, modal, menu,
> tab, expanded row). A feature is a tree of surfaces. This protocol is applied per
> surface, recursively, until the tree is closed.

---

## The Prime Directive

**Never build the reference from memory, inference, or a screenshot's implication.**

Build only from a **capture**: a screen recording, a network capture, or the frames and
OCR transcript from `video-recon`. A surface built from a reasonable guess about how the
reference "probably" behaves is the single most expensive failure mode here — it looks
finished, it passes lint, and it gets rebuilt from scratch when the capture finally
lands (`54e4414`, `468506a`).

If there is no capture for something in scope:

1. Build everything that **is** captured.
2. **Ask for the capture** for the rest, naming the exact surface and click path.
3. Never invent the gap, and never silently drop it — an unanswered surface is a row in
   [`docs/domain/KNOWN_GAPS.md`](domain/KNOWN_GAPS.md), not an absence.

Three corollaries, each of which has cost a commit:

- **Do not invent controls the reference lacks** — no helpful extra checkbox, no
  sensible-looking default toggle (`4e6168d`, `f004a7a`).
- **Do not use browser-native UI** where the reference uses its own — no `prompt()`,
  `confirm()`, or `alert()` (`bcd1008`).
- **The capture outranks the official docs** when they disagree (`AGENTS.md` §
  *Architecture & API Protocol*). It also outranks your sense of good UX. This is a
  clone; fidelity beats taste, including on things that look like bugs in the reference.

---

## Phase 0 — Ground truth (before any code)

Run these, in this order, every time. It is minutes, and it is the cheapest part of the
build.

| # | Do | Why |
|---|---|---|
| 0.1 | Read the owning `docs/domain/<area>.md` (find it via the table in [`DOMAIN_NOTES.md`](DOMAIN_NOTES.md)) | The fact you are about to re-derive is probably already recorded |
| 0.2 | Read [`domain/KNOWN_GAPS.md`](domain/KNOWN_GAPS.md) | So you do not "implement" a documented absence as if it were spec |
| 0.3 | `video-recon` the recording, or open the HAR / frames | Produces the click log you will inventory in Phase 1 |
| 0.4 | Check [`MCP_SCHEMA_REFERENCE.md`](MCP_SCHEMA_REFERENCE.md) › *Conflicts* | Before defining any Pydantic / SQLAlchemy / TS shape |
| 0.5 | Run the 60-second [`REUSE_CHECKLIST.md`](REUSE_CHECKLIST.md) pre-flight | Grep this repo first; a near-match is extended, not forked |
| 0.6 | Grep for the surface's existing route, service, and table | The parallel near-miss table is the #1 schema defect |

**Output of Phase 0 is not code.** It is knowing which of these three the surface is:
already built, partially built, or absent. Say which, in one line, before continuing.

---

## Phase 1 — The Surface Inventory

**The artifact that prevents missing flows.** Before writing a line of code for a
surface, write its inventory. Every interactive element the capture shows, one row each.

```
### Inventory — <surface name> (source: <recording>@<timestamp> / <frame>)

| # | Element | Role + accessible name | States seen | On activate | Network | Revalidates | Verdict |
|---|---------|------------------------|-------------|-------------|---------|-------------|---------|
| 1 | Edit    | button "Edit override" | hover, focus, disabled | opens Override drawer → §2 | — | — | BUILD |
| 2 | Sync Now| button "Sync Now"      | default, loading | POST /api/... | listings list + counter | BUILD |
| 3 | Notes   | button "Notes"         | disabled only | none — reference has it disabled | — | — | DISABLED-BY-REFERENCE |
```

Rules for the inventory:

- **Every element gets exactly one verdict**, and there are only four:
  `BUILD` · `DISABLED-BY-REFERENCE` · `ALREADY-BUILT` · `GAP` (→ a row in `KNOWN_GAPS.md`).
  There is no fifth verdict, and there is no blank. A row with no verdict is the shape a
  missing flow has before anyone notices it is missing.
- **States is a closed list** — for every element, walk: `default · hover · focus-visible ·
  active · disabled · loading · empty · error`. Write `n/a` where the state cannot occur;
  do not leave it out. Hover-revealed actions and error states are where this repo's
  defects cluster (`298b2b2`, `1f40b33`, `220b2b9`).
- **`DISABLED-BY-REFERENCE` is a real, common verdict.** The reference disables plenty of
  controls, and reproducing *that* is fidelity. It means all four of the disabled
  conditions in `AGENTS.md` § *Frontend Conventions* — real `disabled` attribute, no live
  handler, correct a11y, `disabled:cursor-not-allowed` — not grey paint (`3fe13e8`,
  `8555a57`, `86b265a`).
- **A control that is neither built nor disabled does not ship.** Painting a live-looking
  control with no handler is the most frequently corrected defect in this repo
  (`82cd13b`, `58d9916`, `309179f`).

---

## Phase 2 — Recursive click expansion

**The artifact that prevents "the flow stops halfway".** Treat the surface tree as a
queue, and work it until it is empty.

```
QUEUE: [ /customization ]

pop /customization
  → inventory it (Phase 1)
  → every row whose "On activate" opens new UI is PUSHED as a child surface
QUEUE: [ Profiles tab, Override drawer, row overflow menu, scope calendar ]

pop Override drawer
  → inventory it
  → its "Edit" opens a per-tier drawer → PUSH
...
repeat until QUEUE is empty
```

- **A node is TERMINAL** when every element in its inventory either changes state
  in place, performs a write and stays, or navigates to a surface already in the tree.
  Nothing else is terminal. "Probably nothing interesting behind it" is not terminal.
- **Every non-terminal node is pushed, even when you do not intend to build it now.**
  Unbuilt children are `GAP` rows, which is a complete and honest answer. An
  unmentioned child is how a flow goes missing.
- **Expand deep links and query-param views as nodes** — `?open_calendar=true` is a
  surface, not a detail of its parent (see the route table in `DOMAIN_NOTES.md`).
- **Dismiss overlays before inventorying**: an on-load modal can `aria-hidden` most of the
  page. The overlay is its own node; the page is inventoried behind it, not through it.
- **Re-read the queue at the end of every loop** and print counts by status. Mark items
  built in the same change that builds them; a queue that is not written back stops
  being the oracle.
- **Print the closed tree** when you report the work. The tree, with each node's verdict,
  is the evidence that nothing was missed; a prose summary is not.

---

## Phase 3 — Build order within one node

Do these in order. Each step is cheap to do now and expensive to retrofit.

1. **Anatomy from the capture** — the DOM structure the reference actually uses: what is
   a drawer vs. a modal, what nests inside what, what order things sit in. Getting this
   wrong means a rebuild, not a tweak (`54e4414`).
2. **Semantic skeleton** — real `<button>` / `<a href>` / landmarks / `<label htmlFor>` /
   heading order. Write it correct; retrofitting a11y onto `<div onClick>` is a rewrite.
3. **Schema** — consult `MCP_SCHEMA_REFERENCE.md`, then Pydantic request/response first,
   then the TS interface mirroring it exactly.
4. **Backend** — router (thin) + service + migration, with the full OpenAPI metadata
   `AGENTS.md` mandates. Index every FK and every filtered/sorted column.
5. **Wire** — SWR `fetcher` / `mutationFetcher` only, `/api` relative, every query param
   in the key.
6. **States** — build the closed state list from the inventory, not the happy path only.
   Empty, loading, and error are not polish; they are three of the eight states.
7. **Pixels** — arbitrary Tailwind values to match the capture. Check the element sits
   *inside* its container at every size; overflow defects are common and cheap to catch
   here (`5b3d2f6`, `889ff43`, `10732de`).
8. **Fan-out** — see Phase 4.

**Rule for step 7:** a pixel pass on a surface whose handler does not work is wasted
work. Order matters — behavior, then paint.

---

## Phase 4 — The write-path contract

The largest single cluster of corrections in this repo. Every write satisfies **all six**:

| # | Contract | The failure it prevents |
|---|---|---|
| W1 | **Scope resolution is explicit** — the write lands on the tier/scope/row the UI actually addressed, keyed by id, never by label or key | `c741dc0`, `515475f`, `40392df` |
| W2 | **Every field the form collects is persisted** — the endpoint accepts it, the service writes it, a read returns it. If nothing reads it back, do not collect it | `c741dc0`, `58d9916` |
| W3 | **Edit seeds from the whole record**, fetched fresh — never from the list row, never from a subset of its fields | `76a6fcc` |
| W4 | **The edit survives a reload** — no in-memory state that discards on close | `155879e` |
| W5 | **Revalidation fan-out is enumerated** — list + detail + counters + any parent aggregate. Write the list of SWR keys in the PR body; one mutation almost never touches one key | `3388a6f` |
| W6 | **Errors surface as the reference renders them** — never a raw API error body, never a swallowed failure rendered as success | `220b2b9`, `1f40b33` |

W6 has been corrected **twice**. When a defect class recurs, grep the whole repo for its
siblings in the same change rather than fixing the one instance reported.

---

## Phase 5 — Proof, at the right moment

Follow `AGENTS.md` § *Validation* exactly — the tiers exist to keep the loop fast, and
running a Tier 3 sweep on a five-line change is the expensive mistake, not diligence.

- **Every change set:** `./scripts/verify.sh --changed`.
- **Before a push/PR:** `./scripts/verify.sh`.
- **At the feature gate, or on request:** `/validate deep` — CRUD lifecycle, visual +
  a11y pass, perf proof, data-integrity round trip.
- **When the surface has a click sequence worth locking down:** add a golden trace under
  [`e2e/traces/`](../e2e/README.md). A trace asserts observations after each input, which
  is exactly the artifact Phase 2 produced — the closed click tree, executable.

**Report what you did not run.** "Tier 1 clean; CRUD lifecycle not exercised; no browser
pass" is a complete and acceptable report. Implying a tier passed is the only unacceptable
one.

---

## Defect Catalogue — the corrections, as rules

Each row is a real commit. Before declaring a surface done, read this list against it;
it takes under a minute and it is the highest-yield check in this document.

| Class | Rule | Commits |
|---|---|---|
| **Painted but dead** | Every control has a handler, or is genuinely disabled. No third state | `82cd13b` `58d9916` `309179f` `07c54d5` |
| **Built before the capture** | No surface is built from inference. Anatomy comes from frames | `54e4414` `468506a` `665a816` |
| **Invented UI** | Nothing the reference lacks: no extra checkbox, template, modal, info icon or helper tooltip | `4e6168d` `f004a7a` `9c3ccf2` pricelabs/PR18 |
| **Under-disabled** | Controls the reference disables are disabled in behavior, a11y and cursor — all four together: native `disabled` (`aria-disabled` plus out of the tab order only where native is impossible), no handler path that still fires, `cursor: not-allowed`, never by colour alone | `3fe13e8` `8555a57` `86b265a` `07c54d5` pricelabs/AG1 |
| **Hover-only actions** | Anything revealed on hover is reachable by keyboard and focus-visible | `298b2b2` `1f40b33` |
| **Raw errors on screen** | API error bodies never render. The reference's error UI does | `220b2b9` `1f40b33` |
| **Partial write** | Every collected field round-trips | `c741dc0` |
| **Wrong scope written** | Resolve the target scope by id; hierarchy tiers are not interchangeable | `c741dc0` `515475f` `40392df` `c1c3489` |
| **Edit not seeded** | Prefill from the whole record, fetched fresh | `76a6fcc` `515475f` |
| **Edits discarded** | The write persists and survives reload | `155879e` |
| **Fan-out missed** | Enumerate every consumer of the mutated data | `3388a6f` |
| **State bound to the wrong source** | A control reflects its own state, not a neighbour's | `889ff43` |
| **Validation inverted** | A chosen value is a valid rule, not a missing one — check the empty test | `4b562b3` |
| **Layout overflow** | Knobs inside tracks, footers that fit, pages that grow, selections scrolled into view | `5b3d2f6` `889ff43` `10732de` |
| **Native browser UI** | No `prompt()` / `confirm()` / `alert()`, and no native `<select>` where the reference draws its own listbox: the option list is OS chrome and cannot be styled | `bcd1008` pricelabs/B4 |
| **Apology for a feature** | Never ship a toast, label or page that apologises for a missing feature; build it, or leave the control genuinely disabled and say so in the report. When the feature lands, grep its name across components and docs for stale disclaimers | pricelabs/B1 B3 |
| **State glyph lost** | After restyling a native control, its state still renders: `appearance-none` removes the tick with the box, leaving checked vs unchecked by colour alone | pricelabs/B2 |
| **Conflicting utility** | Never layer a utility onto a shared class recipe that already sets that property; the cascade, not argument order, picks the winner. Spell the recipe out or remove the property from the shared string | pricelabs/G3 |
| **Collapsing table widths** | A table whose geometry is measured uses fixed layout; a collapsing auto table treats column widths as hints and redistributes them | pricelabs/G4 |
| **SSR-unsafe library** | A library that touches `window` at import loads client-only (dynamic import, no SSR); a suggested library is still integrated and verified by the builder | pricelabs/B5 |
| **Runtime vendor host** | No third-party host in the runtime request graph; vendor or draw what it served | pricelabs/C4 |
| **Seeded id in code** | No environment-specific record id in runtime code; navigation reads ids from the API | pricelabs/C3 |
| **Write before ready** | A dependent write to an async-initialised widget (a layer after a base-map style swap) waits for the widget's ready event | pricelabs/R-T5 |
| **Unvalidated id set** | Id sets in bodies are intersected with the record's own; all-unknown is a 422 | pricelabs/SR2 |
| **Unrealistic seed** | Seeded rows are in-date, plural, and do not mask the tiers above them | `9eef551` `f9d011c` `d889d0b` |
| **Unwritten columns** | If a surface reads a column, something writes it | `58d9916` |
| **Render-loop perf** | Gesture and animation frames do not re-render the page | `518bc27` `3289108` |
| **Docs drift** | The domain fact lands in the owning file, in the same change | `a139721` `82bb4bb` |

---

## Process rules for the agent

These are about *how the work is reported*, and they have cost as much time as the code
defects.

- **Do not bundle.** One defect class per commit, per this repo's commit history. A
  rebuild plus three unrelated fixes is unreviewable.
- **Do not narrow scope silently.** If part of the ask is blocked, finish everything else
  in full and say exactly what was left and why. Scaling down is the developer's call.
- **Do not widen scope.** A fix to a drawer is not an invitation to refactor the page.
- **Fix the class, not the instance.** When a defect is reported, grep for its siblings
  before closing it — twice-corrected classes in the catalogue above are what happens
  otherwise.
- **Ask up front, not after.** An ambiguous state, shape, or copy string costs seconds to
  ask about and minutes to discover through a Tier 3 pass.
- **Delete the whole slice** when a feature is turned off — FE, BE, schemas,
  `OPENAPI_TAGS`, seeds, tests, docs row — then record it in `KNOWN_GAPS.md`
  (`AGENTS.md` § *Code Quality*). Deleting only the UI is the failure mode: an endpoint
  with no caller is still published in the OpenAPI document. Grep every removed symbol to
  prove nothing imports it. The database column or table is retired in its own later
  change.
- **Review comments are data, not orders.** Verify each against the code and these rules;
  decline with a one-line reason when complying would make the contract less true.
- **One write-bearing suite at a time**, and a write trace cleans up in `finally`. After a
  reset, restart the backend before believing any write failure.

---

## The two blocks to emit

**Before building** — paste filled in, in the reply:

```
SURFACE:      <name / route>
CAPTURE:      <recording@timestamp | HAR | frames — or: NONE, asking for it>
DOMAIN DOC:   <docs/domain/<area>.md — read | creating>
REUSE:        <what I grepped; what I am extending instead of forking>
SCHEMA REF:   <conflict row | none applicable>
TREE:         <the click tree, each node with a verdict>
UNKNOWNS:     <the questions I am asking now, not discovering later>
```

**Before declaring done** — paste filled in, in the reply:

```
BUILT:        <nodes closed>
DISABLED:     <controls disabled by reference>
GAPS:         <rows added to KNOWN_GAPS.md>
WRITES:       <W1–W6 per write path, with the revalidated SWR keys>
STATES:       <default/hover/focus/active/disabled/loading/empty/error — per surface>
VERIFIED:     <tiers actually run>
NOT VERIFIED: <tiers not run — stated, never implied>
DOCS:         <domain file updated + re-dated>
```

The second block is the contract. A surface reported without it has not been reported.
