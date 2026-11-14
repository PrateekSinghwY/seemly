# Autopilot: what a bare `/seemly` does, every time

Saying `/seemly` with nothing after it runs the whole method below, from wherever the build stands.
The human never has to restate any part of it. Each step names the tool that does it and why.
Steps that do not depend on each other run in parallel.

## 0. Decide where the build stands (seconds)

Read `discovery/LESSONS.md`, `discovery/RESUME.md`, the graph dirs (`O status` on each) and the
corrections. Then pick the start:

- **No graph and no RESUME, but a target URL is known** (from AGENTS.md, DOMAIN_NOTES or RESUME):
  start at step 1.
- **No target known:** ask the single intake question (SKILL.md section 0.5).
- **Otherwise:** continue at the first step below whose exit condition is not met. Print
  `RESUMED FROM: <step>`.

## 1. Preflight and login (gate)

- **Edition and login:** `edition_gate.mjs` checks the reference's edition, login, theme and
  language in both browsers.
- **Login:** the human logs in once in the headed window. Copy that session out with
  `export-login.mjs`, so every tool gets its own browser from the saved session. Never attach two
  tools to one window over CDP.
- **Login missing or expired:** stop with BLOCKED (credential). That is the only stop here.
- **Exit:** both tools reach the same edition and login.

## 2. Walk the reference to CLOSED (tool: Playwright, through the orchestrator)

- **Gaps first:** `O requeue --gaps`.
- **Then the walk:** `O explore` in the background, with one worker per scope or prefix in
  parallel.
- **Every interaction kind is fired:** click, right-click, double-click, hover, keys, drag, forms,
  uploads.
- **Each node saves:** screenshot, DOM, AX tree, HTTP and websocket reads, styles, widths.
- **Writes:**
  - A write on records the run itself creates is captured, then undone. Log it with its undo in
    `DIRTIED.md`.
  - A write on existing shared data goes to `pending-writes` for a human ruling.
- **Exit:** frontier 0, every gap has a non-retryable reason, and the per-node invariant holds.

## 3. Judge what the walker cannot (tool: Claude in Chrome)

- **What it covers:** controls the walker left `unfired`, "sample" nodes, ambiguous states, and
  behaviour that needs a person's judgment (is this disabled on purpose? what does this menu do
  with real data?).
- **How:** explore each one on the live reference.
- **Feeding back:** each result goes back as `O requeue <node>` or `O gap <node> --reason`.
- **Not for capture:** Chrome is never used to capture to disk; Playwright does that.
- **Exit:** no unfired control without a reason.

## 4. Scope and plan (tool: local, offline)

- **Scope:** `O scope --map scope.json` tags the nodes by component.
- **Plan:** `O plan` turns the in-scope nodes into units: shell, archetypes, templates, in
  dependency order.
- **The work list:** the graph and nothing else. Every checklist or gap item maps to a node.

## 5. Build units (tool: local, with one subagent per unit, in parallel)

- **Each unit agent gets:** its node packet, plus the method in `reference/backend.md` and the
  repo's AGENTS.md.
- **Build order:** schema, service, router, seed, then UI.
- **Writes:** prove every write on an isolated DB copy.
- **Reuse:** two agents never build the same template.
- **Unit done:** only when its Phase D passes (step 7). Tests alone never finish a unit.
- **QA README:** update it per unit (see step 9).

## 6. Walk the clone (tool: Playwright, on an isolated stack)

- **The stack:** its own DB copy, its own backend and frontend ports. Never the dev servers.
- **The walk:** `O explore` with writes allowed, while unit builds continue (pipeline).
- **Errors:** `errors.jsonl` lists every failing call and script error, with the click that caused
  it.

## 7. Verify every pair (tool: Playwright, the same Chrome build on both sides)

- **Command:** `O verify --ref <ref> --clone <clone> --scope <s> --dead-controls`, with
  `masks.json`, `ws-map.json` and `writes.json`.
- **The checks:** pixels, structure and AX, style, human eye, widths, api and ws, writes, and
  interactions (every reference edge, of every kind, reproduced on the clone).
- **A node counts only** when every check passed with its record on disk (SKILL.md section 0.4).
- **Failures go back to step 5** for the units that own them.

## 8. Loop

Repeat steps 5, 6 and 7 until `O compare` has no unconfirmed line and every in-scope reference
node is verified, or closed as not buildable with a reason.

## 9. Keep the QA document current (every step)

`qa/README_<scope>.md` lives in the build's never-pushed area. It covers, per component:
- the major flows, each with its clone route, its reference link, test steps, status and source;
- features built from other sources, with those sources;
- what is not buildable, and why.

Statuses come from `O report`. Update it whenever a unit or a verify run changes a status.

## 10. Weak links (always on)

Any defect in this skill stops the run (SKILL.md section 0.45): record it, fix it with a test,
push, redo what it touched, then resume.

## 11. Done

- `O report --scope <s>` is clean.
- The QA README matches it.
- One final report to the human, generated from the report:
  - built and verified end to end;
  - built from other sources;
  - not buildable, with reasons.

## Which tool, when (summary)

| Job | Tool | Why |
|---|---|---|
| Login | the human, once, in the headed window; then `export-login` | real session; each tool gets its own browser |
| Walk, capture, screenshots, styles, AX, network, ws | Playwright, through the orchestrator | writes to disk, byte-exact bodies, CDP access, resumable |
| Judgment calls, unfired controls, live spot checks | Claude in Chrome | real profile, cheap to poke; never used for capture |
| Building, seeding, write proofs | local repo, with subagents per unit | isolated DB copy and ports per agent |
| Clone walk and verify | Playwright on an isolated stack | same Chrome build on both sides, so diffs are real |
| Running things at once | ref walk workers per scope, unit builds, and clone walk plus verify as units land | wall-clock time spent only where steps truly depend on each other |
