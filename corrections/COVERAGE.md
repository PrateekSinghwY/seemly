# Coverage: every correction from builds 2026-09-24 to 2026-09-29, and where it lives

Written 2026-09-29, when all local learning was promoted. D = `reference/decisions.md`,
P = `reference/principles.md`, CR = `reference/capture-rules.md`, C = `reference/checks.md`,
X = `reference/defects.md`, T = `reference/tool-split.md`, E = `evals/cases.md`,
S = `SKILL.md`, Q = `scripts/qa/`, G = `scripts/gates/`. "Build-only" means the item was a
scope choice or status request for that build, with no rule to carry forward beyond the one
named.

## 2026-09-24-espn-scores (CORRECTIONS.md rows)

| # | gist | lives in |
|---|---|---|
| T#01 | capture results at a past date | D Time-dependent surfaces; E25 |
| T#02 | every ruling is a correction | D Learning location, Mid-run interruptions |
| T#03 | learning stays local | D Learning location (superseded 2026-09-29: promoted) |
| T#04 | finished vs upcoming card states; sibling section as config | D Result card states |
| T#05 | mid-run git request in a separate worktree | D Mid-run git requests |
| T#06 | DFS with backtracking | D Walk order |
| T#07 | internal navigations are nodes; finite by template dedupe | D Walk order; S §4 live graph |
| T#08 | skip external and social links | D External and social destinations |
| T#09 | chart hover states | CR Charts; C chart_hover_parity |
| T#10 | motion is captured | CR Motion; C motion_parity |
| T#11 | do not stop until built | P No stop between the four messages |
| T#12 | open every control inside a module | CR Every control inside a module; P whole nested tree |
| T#13 | out-of-scope tabs disabled, routes removed | D Build / disable list at intake |
| T#14 | canvas animation from the reference's runtime | CR Canvas and runtime animations; C motion_parity |
| T#15 | interruptions improve the skill | D Mid-run interruptions |
| T#16 | finish everything in one go | P No stop; C self_audit_fresh |
| L9-L12 | fonts per node, state clips, review findings, stand-in masks | C font_parity; CR state clips; D Review findings on behaviour; D Image budget |

## 2026-09-25-espn-standings-teams-players

| # | gist | lives in |
|---|---|---|
| T#01 | same DFS graph + queue for the new scope | D Walk order |
| T#02 | real crests everywhere | D Image precedence (superseded by #37 distinctness) |
| T#03 / 03 | critical decisions by a panel | D Critical decisions by panel |
| T#04 / 04 | team tabs are nodes; nodes found while backtracking are built | P The graph is live; S §4 |
| T#05 / 05 | decide what is built vs disabled | D Build / disable list at intake |
| T#06 / 06 | use each tool for its strengths | T learned table |
| 07 | guards against breakage and missed flows | P Claims of completeness; C self_audit_fresh |
| 08 | pixel and click checks inside the loop | P Pixel and click checks run inside the build loop |
| 09 | new Stats scope | build-only; D Build / disable list |
| 10 | decide, do not ask | D Build / disable list at intake |
| 11 | no progress-report stops | P No stop between the four messages |
| 12 | self-audit at every stop; build the whole nested tree | P self-audit, whole nested tree; C self_audit_fresh, nested_tree |
| 13, 14 | which team tabs to build | build-only |
| 15 | dropdown options never assumed | CR Dropdown options; C dropdown_options_captured |
| 16 | disabled completely, no hover or menu | C disabled_no_hover; X Disabled that looks live |
| 17 | 300-image budget with reuse | D Image budget, Image precedence |
| 18 | finish, push, then next scope | P No stop |
| 19 | status as a structural tree | D Status answers |
| 20 | scope doc is the checklist | D Scope document |
| 21 | news scope and edition confirmation | D Scope document; P Edition gate |
| 22 | build the due scope end to end | D Scope document |
| 23 | executive status in words, no emoji | D Status answers |
| 24 | check a ruling's premise live | D Rulings checked live |
| 25, 27, 34, 36 | finish everything end to end | P The graph is live; P No stop; D Faults reported earlier |
| 26 | Playwright vs Chrome split | T learned table |
| 28 | self-improve | S §11 |
| 29-33, 35 | edition proof; VPN in the Playwright profile | P Edition gate; D Light mode; T VPN row; Q edition_gate |
| 34 | shared media clip; follows done by the human | D Media; S §4 writes |
| T#21 / L-shared-next-distdir | gate must not share the dev build dir | C gate_isolated_build_dir; T; X; E27 |
| T#22 / L-disabled-parity, L-disabled-no-hover, L-menu-hover | disabled parity, no hover, menu hover captured | C disabled_parity, disabled_no_hover; CR Menus; E28 |
| 37 | a person's glance; distinct images; human-eye layer | P A person's glance; C human_eye_qa, distinct_images; Q human_eye; E33 |
| 38 | the whole follow graph; panel for unobservable logic | CR Account-bound features; D Critical decisions by panel |
| 39-ruling / 39 | unstable order kept; observable analogue; roster highlight | D Reference instability, Unobservable server-side effects; CR Account-bound 5 |
| 40 | invented tab; one width; wrong shell design | P Never add an item by hand, shell is contextual; C structure_labels, width_sweep; Q struct_audit, width_sweep; E32, E34 |
| 41 | fix all of it | P No stop |
| 42 | light mode only | D Light mode |
| 43 | crisp done line | D Done line |
| 44 | one branch, one PR | D One feature, one PR; E42 |
| 45 | audit the PR diff | D One feature, one PR; C pr_diff_audit |
| 46 | consolidate learnings before the next build | P Lessons from earlier builds are read; D Faults reported earlier |
| LESSONS L-reset-race, L-leaked-frames | reset while reloading; leaked CDP pages | T rows |
| LESSONS L-line-height-as-declared, L-tabular-nums | declared line-height; tabular digits | CR Declared values |
| LESSONS L-tw-leading-normal, L-global-input | Tailwind v4 traps | T Tailwind row |
| LESSONS L-json-null | JSON null vs SQL NULL | X |
| LESSONS L-api-case, L-partial-records | case drift; merge partial records | CR Partial records |
| LESSONS L-new-image-tables, L-derive-display-rules, L-inline-script-oracle | image walkers; cell checker; inline scripts | C image_walkers_cover_tables, table_cells; CR Saved DOMs, Paged tables; E26 |

## 2026-09-27-espn-nfl-ncaaf

| # | gist | lives in |
|---|---|---|
| 00-consensus | 20 rules agreed before the build | spread across D, P, C (each rule above) |
| 47 | maximise reuse of the earlier components | existing reuse contract (S §5) |
| 48 | edition confirmed through the VPN | P Edition gate |
| 49 | honest-status gaps are a work list | D Claims of completeness; P cheap delta is a defect |
| 50 | disabled tab never carries the active indicator | C disabled_no_hover; X; E37 |
| 51 | empty section printed | X Empty section printed |
| 52 | answer from measured evidence only | D Claims of completeness |
| 53 | close every gap and improve the skill | S §11 |
| 54 | live graph; contextual shell; width sweep; agent per node | P graph is live, shell is contextual; D Agent per node; C width_sweep; S §4; E30-E32 |
| 55 | module dropped as "partner" | P Never drop a module by the builder's own call |
| 56 | every card is clickable; replay overlay with animation | CR Every card is clickable; S §4; E29 |
| 57 | overlay internals re-run the animation | CR Every card is clickable (overlay internals) |
| 58 | wrong module for the state | X Wrong module for the state |
| 59 | no focus ring on charts | C chart_no_mouse_focus; X; E38 |
| 60 | bounded vs full-bleed; generalise the last corrections | CR Per-route chrome and breakpoints |
| 61 | confirm replay and field are built | build-only |
| 62 | overlay opens in view from a scrolled position | CR Every card is clickable |
| 63, 64 | write round trip; wire at creation | P A flow is wired when it is created; C write_round_trip; Q write_roundtrip; S §5 step 8; E36 |
| 65 | anything rendered is interactive | P Anything rendered is interactive; C rendered_targets_backed; E35 |
| 66 | scope is exactly the named sections | D Scope per build |
| 67 | answer honestly per section | D Claims of completeness |
| 68 | ruled-out destination briefed to a builder | D Scope per build; X Ruled-out work briefed |
| 69 | re-check every fault reported earlier | D Faults reported earlier |
| 70 | media: own captions, one shared clip | D Media; C media_play; E43 |
| 71 | final sweep across all sections | C self_audit_fresh |
| 72 | account flyout favourites | CR Account-bound features 1, 6 |
| 73, 74 | one foreground sweep, resume, isolated writes | D Background work; X Test on the human's data; E40 |
| 75 | data drift is not a blocker | D Data drift |
| 76 | PR not syncing | D PR not syncing; T row |
| merge lessons 2026-09-29 | builder contracts, at most 3 builders | D Parallel builders; X Builder collisions; E41 |
| CSync catch 2026-09-27 | names in click traces | C golden_traces_named; G check_traces; X Names in test data; E39 |
| strip lesson 2026-09-28 | 0x0 module is absent | CR state clips; E44 |
| shadow lesson 2026-09-28 | malformed utility dropped silently | C utility_classes_emit; P class is not evidence; X |
| 77 | captured paths in an allowlist and name examples | C names_in_tracked_refs; X Captured path in a tracked list; E45 |

## 2026-10-06-espn-bug-sheet (QA from a tester's bug sheet; promoted 2026-10-07)

QM = `reference/qa-mode.md`.

| # | gist | lives in |
|---|---|---|
| 01 | fresh branch from pulled main | build-only (AGENTS git rules) |
| 02, 13, 15 | ownership rulings on enable/disable rows; nav live iff destination built | QM nav targets; X Seed right, screen wrong |
| 03, 12 | relaunch the headed edition window; health check before a batch | T (edition gate) |
| 04 | batch ends in a reviewed PR | build-only |
| 05, 08, 10 | per-row batch table; poll the sheet for new rows | QM loop step 9; S section 12 |
| 06, 07 | attachments are inputs; unreadable = that row BLOCKED, the run goes on | QM loop step 1; X Attachment unopened |
| 09 | build a ruled-in feature end to end, writes captured by abort | QM loop step 4 |
| 11, 20 | disabled treatment keeps icon and geometry | QM disabled treatment |
| 14 | hover never captured on a dropdown | QM interactive states, shared-atom sweep; X Rest-state capture; E46 |
| 16 | hand-drawn icon | QM icon source; X Hand-drawn icon; E47 |
| 17 | copy mismatch was an account-state variant | QM account-state variants; X State variant read as a bug; E49 |
| 18 | control that exists only after a selection | QM state-only controls; X State-only control missed; E48 |
| 19 | learnings become the QA mode | S section 12; QM; E51 |
| 21 | one-time consent prompt on a consented account | QM one-time prompts; X One-time prompt unobservable; E50 |

## 2026-10-12-pickem-groups (QA from a tester's bug sheet; promoted 2026-10-12)

| # | gist | lives in |
|---|---|---|
| 01 | target host from the tester's URLs | QM loop step 1 |
| 02 | role × lifecycle variant of one box | QM account-state variants, conditional link tables |
| 03, 04 | row = the tester's path, not its title; step gated per record | QM loop step 1, path replay, per-record gates; X title-not-path, one-record-gate; E52, E55 |
| 05 | "fixed" = path replay + same-state side-by-side render diff | QM loop step 7, same-state render diff; S section 12; X symptom-only-proof; E53, E54 |
| lesson | count claims need a controlled before/after | QM counter claims; X stale-count-note |
| lesson | bundle branch shipped without live proof | QM bundle vs live; X bundle-branch-shipped; E56 |
