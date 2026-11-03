| Time-dependent surfaces | a scoreboard, schedule, results or standings surface is captured at a **past date with a full slate**, never the live date: completed-game controls (Gamecast, Box Score, Play-By-Play), final scores and box scores exist only for games already played. The date goes in `REACH`; the date picker is a node of its own so live and upcoming states are captured too; the pinned clock sits after that date | espn-scores/01; **football variant**: the unit is season + season type + week (preseason, weeks, postseason; NCAAF bowls and CFP rounds as their own types), T0 is a completed week, the week strip and season/type selects are nodes, every uncaptured week renders disabled |
| Learnings stay local | the skill's procedure (`SKILL.md`, `INTAKE.md`, `distill.md`, `reference/`, `scripts/`, `templates/`) may be committed and shared; its learning (`corrections/`, `evals/`, every RETRO) is never pushed. Excluded through `.git/info/exclude` on the human's machine, not `.gitignore`, so the exclusion itself is not repo-visible. A correction is any sentence from the human that changes what the next run would do, at intake, mid-run or between runs, and is written the same day | espn-scores/02, 03 |
| Mid-run interruptions | every message the human sends mid-run is a skill improvement, not only a fix for this build: log it verbatim in `CORRECTIONS.md`, apply it from the next step, distill it into this overlay the same turn (a decision, check or capture rule), then resume the DFS node walk exactly where it stopped. A question about whether something was built ("did you miss this?") is answered with evidence (reference vs clone clip) and, when the thing exists, which branch or PR carries it | espn-scores/14, 15 |
| Heading tree | mirror the reference's heading elements and levels exactly (including an h1 inside a card, a zero-height h3), since the reference's accessibility tree is the target; a level the reference skips is recorded, not "fixed" | espn-scores 16 (review pass) |
| Review findings | a fresh-eyes finding about runtime behaviour is checked against the implementing code before it is applied; refuted findings get a one-line reason in the report | espn-scores L11 |
| Critical decisions by panel | any decision that is critical and needs a definitive answer — the scope boundary, what to disable, how far to seed or crawl, anything that could run without end — is given to at least three agents in parallel with the same brief and evidence, each answering independently; a fourth agent then reads the three results, records where they overlap and the strongest point of each, and fixes the final decision by consensus. The consensus, not any one agent, is what the build applies; it is written to ASSUMPTIONS.md with the panel's disagreements | espn-standings-teams-players/03 |
| Build / disable list at intake | at intake, list every sibling control on each in-scope surface (each nav item, tab, menu, select) and **decide it yourself** on the most optimised, fidelity-first path: what the human named is live, every other sibling is disabled (grey, not-allowed, no menu, route removed, KNOWN_GAPS row); record each call in ASSUMPTIONS.md; critical or contested calls go to the panel. Never ask, never leave an unnamed sibling live because it resolves | espn-standings-teams-players/05, /10, /16 (superseded "asks" 2026-09-27) |

## scope-split (corrections 05 + 10, espn-standings-teams-players)
When the human names new surfaces: enumerate every control and sub-page they contain, then decide
built vs disabled yourself; never ask. Default: build the default state + every closed-set
switch (tabs, categories, 2-value selects) + paging/sort; disable open-ended multipliers
(other seasons, splits, years). Contested or loop-risk calls go to the 3-agent panel + consensus.
Record the split in ASSUMPTIONS.md and the corrections file.
## status-as-tree (correction 19, espn-standings-teams-players)
When the human asks what is built, answer with a structural tree of every surface and control
with a per-node verdict (built / disabled / building), then keep building in the same turn.

## Consensus panel for unobservable logic (correction 38)
When the reference's behaviour is decided server-side and only partly observable (ranking,
personalization, recommendation), do not guess alone: brief three independent agents with the same
evidence file and constraints (AGENTS.md, the graph doc), one of them skeptical and one optimising
for what a human reviewer notices; adopt the majority ruling per item, record dissent and the
evidence in `discovery/<feature>-panel.md` and an ASSUMPTIONS row, and build the adopted rule with
a write → read → UI test.
| Consensus panel procedure | a critical call (scope boundary, seed bound, unobservable logic) goes to three agents given the same brief independently; the result is the majority per item, every dissent recorded in `discovery/<x>-panel.md` with an ASSUMPTIONS row; no fourth agent is needed | espn-standings-teams-players/03, /38, /46 (one procedure, 2026-09-27) |
| Image precedence | the 300-file budget (#17) never overrides distinctness (#37): no two teams share a crest, no two players on one card share a face, a meaning-bearing image stays genuine; a team without a kept crest shows a neutral league / sport mark | espn-standings-teams-players/17, /37 (2026-09-27) |
