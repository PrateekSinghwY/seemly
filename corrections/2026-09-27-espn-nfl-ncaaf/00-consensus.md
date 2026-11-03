# NFL + NCAAF build — consensus learnings (3 independent reviewers, 2026-09-27)

Source corpus: espn-scores CORRECTIONS T#01-16, standings CORRECTIONS T#01-22, standings #07-46.md,
overlay/*, standings/LESSONS.md. Majority per item; unanimous unless noted.

## Rules (all 3 agree), severity order
1. Edition gate first, every session and capture run: Playwright (VeePN) and Claude in Chrome both on www.espn.com, espn-en-us, printed to the human. No espn.com visit before the VPN connects. check: tools/check_edition.mjs.
2. Never claim built from memory: quote fresh sweep numbers (ui_gap, struct_audit, lay_measure) and name any layer not run.
3. Never add an item to a captured list by hand; copy the live DOM. check: struct_audit.mjs 0 local-only labels.
4. No two teams share a crest, no two players on one card share a face; neutral league/sport fallback; meaning-bearing images genuine. check: check_distinct_crests.py, qa_human_eye.mjs.
5. Disabled = grey + not-allowed, no hover/focus/flyout, same on every surface, route + schema removed, KNOWN_GAPS row. check: check_nav_parity.py (ran:true, compared>0) + hover assertion.
6. Decide built vs disabled myself at intake for every sibling nav item / tab / menu / select; ASSUMPTIONS row each. Never ask (except the one INTAKE question).
7. Enabled dates/weeks/dropdown options only where captured; the rest native-disabled with a reason. check: dropdown-options-captured gate, qa_human_eye enabled-empty rule.
8. Human-eye QA after every built slice. check: qa_human_eye.mjs exits 0.
9. Multi-viewport: 1024/1280/1440/1680 and N-1/N/N+1 at breakpoints; classify each route's shell (legacy vs fitt) before shared chrome. check: lay_measure.mjs, _gnav_cmp.mjs.
10. "Build X" = the whole nested tree, including controls inside ruled-out modules. check: pix tree role counts.
11. DFS every same-origin control; re-queue nodes found while backtracking; skip external/social. check: no queue.jsonl node without a verdict.
12. Charts and motion are captured channels (hover sweep, getAnimations, the reference's runtime). check: chart_hover_parity, motion_parity, clip pairs per variant.
13. A cheap known delta is a defect to fix, not a gap. Gaps = ruled-out scope or blocked data only.
14. Critical calls -> 3 independent agents, majority per item, dissent recorded (discovery/<x>-panel.md).
15. No progress-report stops: only PREFLIGHT FAILED / BLOCKED / SESSION CHECKPOINT / DONE. Status for executives in words, structural tree with verdicts, no emoji.
16. Light mode only. check: capture profile forces prefers-color-scheme: light.
17. One feature = one branch = one PR; `gh pr list` before `gh pr create`; audit `git diff --name-status main...HEAD` (no db / binary junk / 0-byte files); PR body matches the diff.
18. No gate spawns Next inside frontend/; never touch next.config.mjs.
19. Tables: every column, both sort directions, all pages; merge partial records; case-insensitive category match; cell-by-cell checker; schema-validate each seeded page.
20. Measure hover / focus / active / disabled live on the reference (forcePseudoState), never assume.

## Football-specific risks (all 3 agree)
- Weeks not dates: season + season type + week, week strip and selects are nodes, T0 a completed week, uncaptured weeks disabled; bowls / CFP as season types.
- 130+ FBS + FCS opponents + 32 NFL crests vs the 300-file budget: plan per screen, neutral fallback, distinct-crest gate over every NCAAF card (panel decides the bound).
- NCAAF group filters (Top 25, FBS/FCS, conferences) and AP/CFP rank prefixes: capture each option page; rankings seeded per week, never derived.
- Drive chart / field-position gamecast: new chart + motion runtime; never reuse the basketball court; clip pairs per play variant (TD, FG, punt, turnover, home/away).
- Not NBA config rows where football differs: `/college-football/` URLs, single-year seasons, depth chart by unit, conference vs overall records, clinch marks, bye weeks, stat categories; extend the existing NFL stats, never fork.

## Contradictions resolved in the overlay (2026-09-27)
- decisions "Build / disable list at intake ... asks" -> decide myself (#10 wins).
- #17 "a wrong player's face is fine" / #02 crest exemption -> #37 distinctness wins (decisions "Image precedence").
- Two panel procedures -> one: 3 independent agents, majority per item, dissents recorded.
- L-next-routes-stale -> superseded (never touch next.config.mjs). L-reset-race -> reset_safe.sh only.
- Human-eye "after every built thing" vs AGENTS Tier 3 -> the human's #37 ruling wins for this build family, per slice.
- Correction number collision -> cite T#NN (table rows) vs #NN.md (files); new build uses NN.md only.
- #44 "push onto the existing PR" -> for NFL/NCAAF: one fresh feat/* branch and one PR for the whole build.
- Time-dependent rule -> football week variant added.
