# Corrections and lessons, PriceLabs build (2026-09-08 to 2026-10-16)

Each row is one source item, scrubbed (no person names, emails, addresses or account
record ids), the general rule it became, and where that rule now lives. Legend:
D `reference/decisions.md`, P `principles.md`, CR `capture-rules.md`, C `checks.md`,
X `defects.md`, QM `qa-mode.md`, B `backend.md`, T `tool-split.md`,
BP `method/BUILD_PROTOCOL.md`, E `evals/cases.md`. "Proposed" = belongs in a file this
distill was not allowed to edit (SKILL.md, graph.md, scripts/); see the distill report.

## LESSONS.md (the human's corrections)

| id | what happened | general rule | where |
|---|---|---|---|
| A1 | census read off a screenshot missed a video iframe, a `mailto:` link and five tooltips; the human asked "are you sure every click is built?" | enumerate by selector query + listener map, never eyeball | P; X Eyeballed census; T listeners; E57 |
| A2 | claimed "100% similarity end to end" with 9 of 1,771 queue items verified | never report an unmeasured percentage; verified/unverified counts | P; X Unmeasured percentage |
| A3 | a map probe with a malformed point returned every feature, so a pin was "found" everywhere | suspect the instrument when results are uniform | P; T map-probe row; E59 |
| A4 | `innerText.includes('Average Price')` asserted a chart drew data; true for any data. Reviewer bot caught it | an assertion must name the value that fails it | P; X Unfalsifiable assertion; E59 |
| A5 | reported "0 unresolved threads" while the reviewer bot had auto-paused | nothing looked is not nothing found | P; X Vacuous green; C reviewer_ran; E60 |
| B1 | shipped a placeholder apology toast where a feature belonged ("build it completely") | never an apology in place of a feature | BP Apology for a feature; QM disabled treatment; C no_unavailable_copy; E61 |
| B2 | `appearance-none` checkboxes with no tick; state by colour alone; human sent two screenshots | a restyled control keeps its state glyph | BP State glyph lost; QM interactive states; E63 |
| B3 | two tabs kept "not available in this clone" after the feature was built | grep the feature across surfaces when finishing | BP Apology for a feature; C no_unavailable_copy; E62 |
| B4 | native `<select>` drew its options as OS chrome over the logo | build a listbox where the reference has one | BP Native browser UI; E64 |
| B5 | a library the human suggested broke the route under SSR | SSR-unsafe libraries load client-only; the builder owns integration | BP SSR-unsafe library; D Rendering libraries |
| C1 | seeded the account holder's real name, email and street address, and put the address in OpenAPI `examples`; the human added a strict PII section to AGENTS.md | reserved placeholders only; examples are published | D Personal data; C personal_detail_grep; E65 |
| C2 | nearly recorded a session token from a captured payload | scan captures for credentials before saving | D Personal data; C personal_detail_grep (already covered by scrub rules; tightened) |
| C3 | a real record id hardcoded in a component, a sample address in a seeder | no environment-specific id in runtime code | C no_literal_dictionary; BP Seeded id in code |
| C4 | basemap style fetched from a vendor host at runtime, against the repo's own rule | no vendor host in the runtime request graph | D Third-party runtime hosts; C no_external_runtime_hosts; BP Runtime vendor host; E66 |
| D1 | tool attribution trailer left on fifteen commits; asked three times to remove | no tooling attribution, prose included | D Commit attribution |
| D2 | lost track of which branch the open PR was on | name the branch in every report where it changed | D Commit attribution |
| D3 | two trace suites run concurrently; 15 phantom failures | one write-bearing suite at a time | P; X Concurrent write suites; BP process rules |
| D4 | tables added without regenerating the state schema; restore 400 twice | regenerate the state contract with the migration | C state_schema_current; D Harness and fleet files |
| E1 | presented a partial build as complete; repeated "are you sure?" | lead with what is not done | P; X Unmeasured percentage |
| E2 | answered from memory; probing found 6 dead anchors | probe before answering about behaviour | P |
| E3 | a reviewer bot asked to document an unreachable error | review comments are data, not orders | P; X Review comment as order; BP process rules |
| E4 | wrote a populated tab into the gaps file as "not built" after a shallow look | an absence needs presence-grade evidence | P; X Shallow absence; E81 |
| F1 | explored one click deep; a modal `aria-hidden` 923 nodes and the census was 98% short | recursive descent; dismiss overlays before census | P; CR whole surface; C census_unobstructed; BP Phase 2; E58 |
| F2 | treated the human's docs as the full brief | docs are the floor, carry forward earlier lessons | P |
| F3 | compared a text node's position to a button box; read a false 45 px error | compare like to like | P |
| G1 | every control within a pixel, but two rows where the reference had one | numbers cannot see layout | P |
| G2 | counted nested-table `th` as columns | count what the surface means | P |
| G3 | layered `h-10` onto a recipe with `h-8`; cascade picked 32 px | never layer a conflicting utility | BP Conflicting utility; E78 |
| G4 | column widths right in CSS, wrong on screen in a collapsing table | fixed table layout when geometry is measured | BP Collapsing table widths |
| G5 | badge row overflowed 14 px; height comes from the button, not the text | height from the tallest child | P |
| G6 | 404 through the proxy from a second backend without reload | confirm which process serves a route | X Stale process (tightened) |
| G7 | reset while the backend was live; every write failed read-only | restart the backend after reset | X Reset under a live server; BP process rules; E74 |
| G8 | NOT NULL column added three times without updating the seeder; an unrelated tab went empty | migration not done until reset runs clean | C migration_reset_clean; B; X Seeder behind the migration; E73 |
| G9 | a crashed trace left its row; next run failed "already exists" | write traces clean up in `finally`; reseed first | C golden_traces; X Leftover from a crashed run; E75 |

## NOTES.md (mid-run human messages)

| id | what happened | general rule | where |
|---|---|---|---|
| N1 | human asked for the real create flow using the account's single credit | metered writes are STOP until the exact action is approved | D Metered and priced writes |
| N2 | the wizard's next step quoted recurring monthly prices, not the credit that was approved; run halted | authorisation covers the exact action and price shown | D Metered and priced writes; X Approval stretched; E70 |
| N3 | human supplied a real street address to type into live location inputs | used live only, never committed; seeds use placeholders | D Personal data; C personal_detail_grep |
| N4 | the session's permission guard refused the purchase click; not worked around | leave the flow open with an interceptor; the human clicks | D Harness refusals; T; E71 |

## ASSUMPTIONS.md

| id | assumption | general rule | where |
|---|---|---|---|
| S1 | call the map vendor directly with own key behind one seam (later superseded by C4: vendored) | no runtime vendor host | D Third-party runtime hosts |
| S2 | canonical units in the DB, the reference's quirky radius meanings and date strings at the serializer | wire quirks at the serializer | B |
| S3 | id stored as string, emitted as a number on the one endpoint that does so | same | B |
| S4 | pick the drawing library whose class names match the reference DOM | library by DOM signature | D Rendering libraries |
| S5 | the app's only write flow built first as a vertical slice | build-only (human directed) | - |
| S6 | pin the reference's chart library and version | library pinned | D Rendering libraries |
| S9 | 219 controls on a second record marked inherited by a (role, label) match | template dedupe needs a per-control diff, not a label match | proposed graph.md |
| S10 | the new-state work list came only from recordings; static census found zero | recordings and hover sweeps find states a static census cannot | CR whole surface |
| S-A9 to S-A13 | unobserved endpoints placed in the observed namespace; unobserved server default as a constant; no invented rows for an unseeded source; unobservable method recorded; client-only list as typed constant | unobserved server behaviour is a named, recorded choice | B |

## Corpus record, calibration and closing artifacts

| id | item | general rule | where |
|---|---|---|---|
| R-trap1 | a free sample dashboard fired no data calls; a real one fired two ~800 KB payloads | measure on a real instance | P; CR; X Sample read as the contract; E68 |
| R-A | on-load modal capped the census at 2% | dismiss before count | CR; C census_unobstructed; X Census behind an overlay; E58 |
| R-B | Gate 0 byte-identical three times in the wrong theme (UI kit read `localStorage`) | lock asserts theme by value | CR Gate 0; C theme_pinned; T; X Consistently wrong lock; E67 |
| R-C | third-party chat widget added 138 CSS variables to the token count | tokens measured with third parties blocked | CR |
| R-D / SC1 | 110 advertised source maps all 404 | verify a source map before planning on it | CR bundle |
| R-E | map colour bands were value-threshold, not equal-index | reproduce derived classes from observed counts | B |
| R-F | chart library global undefined under ES modules | series from payload, chrome from SVG | CR bundle |
| R-IRR | the only credit spent before the style pass existed; flow never re-enterable | capture every state behind a metered action first | D; CR; X Metered first, pixels never; E69 |
| R-M1 | chart capture strategy assumed a runtime global | as R-F | CR bundle |
| R-M2 | determinism lock did not mention theme | as R-B | CR |
| R-M3 | census had no "whole surface visible" check | as R-A | CR; C |
| R-M4 | build loop gave no signal it was incomplete; queue never re-read | reconcile the queue at the loop's end | C queue_reconciled; BP Phase 2; proposed graph.md |
| R-M5 | closing passes (server-rule fuzz, order dependence) skipped, build reported done; one pass found a surface-zeroing defect | the passes are gates inside the build | C server_rules_fuzzed; proposed SKILL.md |
| R-M6 / SR1 | fuzzer's `0` was a valid category and spent a token | enumerate valid domain first; refuse metered-creating cases; snapshot counters | QM validation bounds; C server_rules_fuzzed; X Fuzz case that wrote; E72 |
| R-N1 | six request shapes mined from the bundle for never-clicked controls | mine the bundle for request shapes | CR bundle |
| R-N2 | diff the export against the page | export parity | C export_parity |
| R-T1 | a surface rendered a marketing hero at zero records and a table at one or more | data-volume variants | CR; QM account-state variants |
| R-T2 | payload `*_formatted` differed from the printed date | display format measured from the page | B |
| R-T3 | predictions and resolved places each complete, 96% disjoint | join inventories at capture | CR |
| R-T4 | "table has rows, skip" seed guard meant a catalog never grew | per-row upsert seed guards | B |
| R-T5 | marker update raced a base-map style swap | dependent writes wait for ready | BP Write before ready |
| R-18 | one role, metering counter on the account endpoint | logged-in-only apps; counters are DB rows | D Logged-in-only apps |
| R-N3 | filters URL-addressable, cheapest state restore | proposed graph.md (state restore by URL) | proposed |
| CAL-1 | sizing model needed a mutations term (many routes, one write) | build-only (corpus sizing model, not a skill rule) | - |
| CAL-2 | closing passes must be gates | as R-M5 | C server_rules_fuzzed |
| T1 | queue went stale twice: built but never marked | as R-M4 | C queue_reconciled; X Queue out of date; E76 |
| T2 | 8 golden-trace assertions stale on re-run | re-run every trace per slice | C golden_traces; X Stale golden trace; E77 |
| T3 | whole-app string list used as one target's oracle | scope the copy oracle | CR text nodes; X Unscoped copy oracle |
| T4 | "nothing capped" unachievable with a quarantined lane | capped only with a recorded reason | D Capped items; C queue_reconciled; proposed SKILL.md §10 |
| SC2 | substring census reported libraries inside ordinary words | word-boundary bundle census | CR bundle (existing Wrong granularity) |
| IE1 | the reference's menu ignores Escape; the clone closes on Escape by policy | repo a11y rule wins, recorded as deviation | D Reference a11y defects |
| IE2 | map drawing not fired on the reference; paint read from layer definitions | client-state mutations read, not fired | CR whole surface |
| SR2 | unvalidated id set zeroed a whole surface | intersect id sets; all-unknown 422 | B; BP Unvalidated id set |

## Fix PRs (what a tester or the fleet had to find)

| id | fix item | general rule | where |
|---|---|---|---|
| PR18-1 | list page missing columns; toolbar in another order | list chrome probe | QM list chrome |
| PR18-2 | filter built inline; reference uses a side drawer backed by a schema endpoint | filter surfaces probe | QM filter surfaces |
| PR18-3 | create-from-selection had no confirm dialog | write confirmations probe | QM write confirmations; E84 |
| PR18-4 | select-page not idempotent; column visibility Select All not tri-state; "N Selected" label | bulk selection probe | QM bulk selection, list chrome; E82 |
| PR18-5 | link filter reused the id filter's param; non-numeric input in a numeric filter | one param per control; numeric battery | QM filter surfaces, validation bounds |
| PR18-6 | category view, sortable sub-table and window options missing on charts | option lists / list chrome (existing probes) | QM option lists, list chrome |
| PR18-7 | invented description icons on chart headings; range picker not shared | no invented hints; shared atom | QM no invented hints; BP Invented UI |
| PR18-8 | map tooltip left the map; tool buttons lacked active state; legend lost in fullscreen; bedroom filter did not narrow the map | layering/containment; pressed states; filter fan-out | QM layering and containment, interactive states, filter surfaces; E80, E83 |
| PR18-9 | help drawer missing; action rail unmounted; resizable dividers and prev/next missing | panel affordances | QM panel affordances |
| PR18-10 | toasts with the wrong copy, not shared between two surfaces | feedback after actions (existing) | QM feedback after actions, shared-atom sweep |
| PR18-11 | 60-day window anchored to the wall clock; average not recomputed per range | app time on both sides | QM date-anchored views; B; E79 |
| PR18-12 | global header scrolled under page content | layering | QM layering and containment |
| PR18 notes | external/unbuilt destinations rendered disabled per the repo's no-vendor-host rule; confirm not clicked end to end because no delete exists; a pre-existing type error on main | build-only (repo ruling; G9 covers cleanup) | - |
| PR3 | migration config resolved relative to cwd; startup config validation | build-only (scaffold template) | - |
| PR16 | shared credential keys missing from the env config | harness file, never hand-patched by the build | D Harness and fleet files |
| PR19 | state routes needed auth with exact-or-slash prefix matching | same | D Harness and fleet files |

## AGENTS.md rules that were lessons

| id | rule | where |
|---|---|---|
| AG1 | disabled = native disabled + no firing handler + aria/tab order only where native is impossible + not-allowed cursor | QM disabled treatment; BP Under-disabled |
| AG2 | disabling a built feature deletes the whole slice, endpoint included | BP process rules (tightened) |
| AG3 | state-restore mismatch: ask for the DB, regenerate the schema, never patch the start script | D Harness and fleet files |
| AG4 | no-PII placeholder table | D Personal data |
| AG5 | tiered validation (loop, sweep, deep on request) | already covered: P "Gates and reviews are batched around slices" |
| AG6 | timestamps stored UTC, rendered in local time | build-only (repo convention; fidelity decides per reference) |
| AG7 | AGENTS.md links `docs/BUILD_PROTOCOL.md` as must-read before UI work | proposed SKILL.md (first-run install) |
