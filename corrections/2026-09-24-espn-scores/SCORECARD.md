# SCORECARD: espn.com NBA + WNBA scoreboard and game pages, 2026-09-25

Measured at the end of the "finish it all" run (correction 16), branch
`feat/nba-wnba-scoreboard` @ cf95abf. Previous column: the five-page espn build.

| metric | how measured | target | this build | previous |
|---|---|---|---|---|
| Provenance | text nodes resolved / total | 100% | not re-run this pass (last run: 0 unresolved at T0 parse) | 8204/8204 (espn) |
| Unresolved strings | count | 0 | 0 (no-literal gate: 0 hits, 3386 dictionary entries) | 0 |
| Pixel parity, modules | modules with 0 differing pixels / total | 100% | 0 / 75 at 0 px (anti-alias threshold 32/channel): 11 under 1%, 18 at 1-3%, 24 at 3-8%, 23 over 8% | n/a |
| Pixel parity, size | modules whose box equals the reference | 100% | 58 / 75 paired modules equal to 0.5 px; of the 17 others, 14 are news lists that changed after T0 and 3 are harness mis-pairings (scoreboard performer headings) | |
| Over-8% causes | per module | explain | 6 rail clip cards (the reference autoplays video in the poster), 14 news lists (content changed after T0), 3 scoreboard performer pairings (harness paired a heading to its card) | |
| Structure parity | click-trace steps passing / total | 100% | 219 / 228 pass, 9 waived with reasons in scripts/traces/scoreboard_game.json | |
| Style parity | font diff per text node, 9 routes | 0 lines | 0 on game routes except declared (hidden h1, a duplicate "Points" span); scoreboard: date-strip duplicate-text noise only | shell 4 ceilings / 68 |
| Declared ceilings | count, with reasons | minimise | 9 (step8.md): Recharts tie-break (4 hover positions), venue icon changed after T0, predictor share row (no social), PBP inline rows lack the accordion button, live WNBA clip list drift, news drift, video autoplay, image budget stand-ins beyond 13, strip network button disabled | ads, video, live, embeds |
| Click tree | nodes closed / discovered; capped | 100% / 0 | 83 nodes; capped by DEPTH=1 only (345 depth-capped edges are out-of-depth destinations, as intake set) | |
| Golden traces | clean / total | 100% | 7 routes, 0 failed, 9 waived | |
| Reuse | component files changed on pages after the first | 0 | WNBA, pre-game and TBD pages are data rows on the same components; this pass changed shared components only | |
| Literal gate | hits at DONE | 0 | 0 | 0 |
| Personal-data grep | hits at DONE | 0 | 0 | 0 |
| Human interventions | mid-run messages | < 3 | 13 (corrections 04-16) | ~15 |
| Questions asked | count | 0 | 0 | ~8 |
| Full sweep | ./scripts/verify.sh | green | all gates pass except PAGE COMPLETE, which covers only the five feed pages of the earlier build (pre-existing, unchanged) | blocked |
| Lessons | rows; wired; promoted | all wired | 12 (L1-L12); each names a check; 0 promoted | 26; 26; 2 |
| Corrections not applied by distill | count | report | 0 | |
