# Build: PriceLabs dashboard clone, 2026-09-08 to 2026-10-16 (distilled 2026-10-26)

Target: the PriceLabs web app, a logged-in pricing SaaS (market dashboards with charts and
a vector map, a pricing calendar, multi-calendar, listing management, customizations, a
revenue estimator). Repo: `rl_pricelabs`. One user, no roles; one metered create
(credits) and one token-metered create; everything else read-heavy. Built across nine
feature PRs, then a 51-ticket tester QA sheet (PR #18) and two environment fixes from the
fleet (PR #16, #19).

Sources distilled, all scrubbed of personal data and account record ids:

| source | rows | id prefix |
|---|---|---|
| `discovery/LESSONS.md` (corrections the human had to give) | 34 | A1-A5, B1-B5, C1-C4, D1-D4, E1-E4, F1-F3, G1-G9 |
| `discovery/NOTES.md` (mid-run human messages) | 4 | N1-N4 |
| `discovery/ASSUMPTIONS.md` | 11 | S1-S6, S9, S10, S-A9 to S-A13 |
| corpus record `rl-corpus/records/pricelabs.md` (traps, what the method got wrong, irreversible lane) and `CALIBRATION.md` | 21 | R-*, CAL-* |
| `discovery/TERMINATION`, `surface-census`, `input-effect`, `server-rules` | 8 | T1-T4, SC1-SC2, IE1-IE2, SR1-SR2 |
| git `fix:` PRs #3, #16, #18, #19 | 4 PRs, 15 fix items | PR3, PR16, PR18-1..12, PR19 |
| repo `AGENTS.md` lesson-shaped rules | 7 | AG1-AG7 |
| repo `docs/BUILD_PROTOCOL.md` vs the skill copy | identical, nothing new | - |

`CORRECTIONS.md` holds each row, the rule it became and where it now lives.
`../COVERAGE.md` § 2026-10-26-pricelabs maps every id. No `RETRO.md` was written by this
distill; the build's own "what the method got wrong" lives in the corpus record and is
mapped here as R-M1 to R-M5.
