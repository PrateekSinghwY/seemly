# SCORECARD: <target>, <date>

Written at `DONE` and at every `SESSION CHECKPOINT`, to `corrections/<build>/SCORECARD.md`.
These numbers are the skill's accuracy. Targets are the bar; the previous build's row is
the baseline the next one must beat.

| metric | how measured | target | this build | previous |
|---|---|---|---|---|
| Provenance | text nodes resolved / total | 100% | | 8204/8204 (espn) |
| Unresolved strings | count | 0 | | 0 |
| Pixel parity, modules | modules with 0 differing pixels outside masks / total, all pages | 100% | | n/a (oracle incomplete) |
| Pixel parity, area | masked area as % of page area, per page | report | | |
| Structure parity | elements with DOM path, role, name, text, href equal / total | 100% | | |
| Style parity | elements with 0 property diffs or declared ceiling / total | 100% | | shell 4 ceilings / 68 |
| Declared ceilings | count, with reasons | minimise | | ads, video, live, embeds |
| Click tree | nodes closed / nodes discovered; capped nodes | 100% / 0 | | |
| Golden traces | clean on 4 channels / total | 100% | | |
| Row-count parity | page_module rows where reference = seed = endpoint | 100% | | |
| Reuse | component files changed on pages after the first | 0 | | |
| Archetypes vs cells | components / module×page cells rendered | report | | 14 / 69 |
| Literal gate | hits at DONE | 0 | | 0 |
| Personal-data grep | hits at DONE | 0 | | 0 |
| Human interventions | messages the human had to send mid-run | < 3 | | ~15 |
| Questions asked | count | 0 | | ~8 |
| Time to first visible page | from preflight | < 2h | | ~6h |
| Time to DONE | wall clock | report | | |
| Convergence rounds trend | predicted / actual per slice | flat or falling | | 3/2, 4/? |
| Lessons | rows; wired; promoted | all wired | | 26; 26; 2 |
| Corrections not applied by distill | count, with reasons | report | | |
