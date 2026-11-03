# SCORECARD: espn.com NBA / WNBA Standings, Teams, team tabs, Players + NFL/NBA/WNBA Stats, 2026-09-26

Written at the build's scope close (not `DONE`: the full sweep's PAGE COMPLETE gate still fails on
the earlier build's five feed pages, outside this build's scope; see "Not met").
Every number below was measured in this build; a blank means not measured, said so.

| metric | how measured | target | this build | previous |
|---|---|---|---|---|
| Provenance | text nodes resolved / total | 100% | not measured this build | 8204/8204 (espn) |
| Unresolved strings | count | 0 | 0 literal-gate hits (no-literal + JSX AST gates) | 0 |
| Pixel parity, modules | modules passing pix (0 fail at maxPct 1, size, position, links, tree) / total, UI-GAP over 70 routes | 100% | 189/200 (the 11 others: news cards skipped for oracle drift, A6/A10; each passes 0 px on its T0 oracle) | n/a (oracle incomplete) |
| Pixel parity, area | masked area | report | ads + partner links + stand-in images masked (ruled); per-page area not computed | |
| Structure parity | link role/name/dest per module (pix struct) | 100% | 200/200 modules, differences only by listed rulings | |
| Style parity | computed-style manifest diff | 100% | not measured (pix geometry + pixels used instead) | shell 4 ceilings / 68 |
| Declared ceilings | count | minimise | 0 open (Standings stat column right edges earlier ceiling superseded: now 0 px) | ads, video, live, embeds |
| Click tree | nodes closed / discovered | 100% / 0 | not measured as a graph; scope enumerated in the tree map (correction 19) | |
| Golden traces | clean on 4 channels | 100% | not written | |
| Row-count parity | reference = seed = endpoint | 100% | team-tab sorts 80/80; Stats sorted pages 248/252 cell by cell (4 = reference drift, A15); dropdown options 8251, 0 violations; Players searches 5/5 exact | |
| Reuse | component files changed on pages after the first | 0 | not measured per page; Stats reused TableCard tokens, PillSelect, Glossary, SmartLink, NewsCard (one new variant) | |
| Archetypes vs cells | components / module x page cells | report | not measured | 14 / 69 |
| Literal gate | hits at scope close | 0 | 0 | 0 |
| Personal-data grep | hits at scope close | 0 | 0 | 0 |
| Human interventions | messages the human had to send mid-run | < 3 | 19 corrections (01-19) | ~15 |
| Questions asked | count | 0 | 2 recorded (scope answers per 05; Stats answers per 09) | ~8 |
| Time to first visible page | from preflight | < 2h | not recorded for this build | ~6h |
| Time to scope close | wall clock, walk start 2026-09-25T10:11Z -> 2026-09-26T12:40Z | report | ~26.5h across sessions | |
| Convergence rounds trend | predicted / actual | flat or falling | Players 9 pix rounds; Stats 9 pix rounds (not predicted up front) | 3/2, 4/? |
| Lessons | rows; wired; promoted | all wired | 25 rows in discovery/standings/LESSONS.md; wired as checks: check_stats, check_sorts, check_dropdowns, pix rulings; promoted: 0 | 26; 26; 2 |
| Corrections not applied by distill | count | report | distill not yet run for this build | |

## Not met
- PAGE COMPLETE (full sweep) on /, /nfl/, /college-football/, /nba/, /wnba/: the earlier build's
  feed pages against the 2026-09-22 oracle (live-content drift; the oracle predates the scores
  strip and footer). Needs a re-captured T0 for those five pages.
- Corpus record in `../rl_components/rl-corpus/` not written: AGENTS.md forbids modifying
  rl_components.
