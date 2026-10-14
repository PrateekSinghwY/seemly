# Build: ESPN home pages, 2026-09-22 to 23

Target: espn.com home plus NFL, college football, NBA, WNBA homes, then the Favorites
feature. Repo: `rl_espn`. Outcome at the time of distill: seed complete with 100 percent
provenance (8,204 text nodes, 2,600 rows, zero typed data), shell converged to the
capture, one page component for five routes, page bodies not yet built, scores strip
never captured (capture filter defect). Roughly 14 hours, about 15 human interventions.

Each numbered file is one human message, verbatim in substance, with the phase it
arrived at and what it changed. The `class` column drives `distill.md`.

| # | phase.step | class | one line |
|---|---|---|---|
| 01 | design | scope | five pages, shared layout, reuse components, zero hardcoded data, zero personal details, scrape real data with the best tools |
| 02 | design | process | add learning-from-mistakes: the agent must improve itself during the build |
| 03 | install | process | do not make me paste files; write them yourself |
| 04 | install | process | Chrome must be Claude in Chrome from Claude Code; local URL is localhost:3000; full stack end to end, no scraped data missing, best schemas |
| 05 | recon | tooling | Playwright was made the source of truth; wrong: Claude in Chrome is primary, Playwright only where Chrome lacks |
| 06 | recon | process | automation is stopping; why so many questions |
| 07 | recon | tooling | which browser is being used; how do I check |
| 08 | recon | pace | where are we lacking; what is needed for pixel parity (answer: oracle at T0, pixel-diff with masks, fonts, same renderer, ads and video ceilings) |
| 09 | recon | tooling | is it Chrome or Playwright CDP right now |
| 10 | recon | ruling | I am logged in and on the US site; use the data, build from it, what is the issue |
| 11 | recon | ruling | put Playwright on the US edition; I will open the window and log in myself |
| 12 | recon | process | status check: which stage, what is happening |
| 13 | scrape | ruling | feed paginates on scroll: reversal accepted, implement offset/limit, home feed separate archetype |
| 14 | scrape blocked | ruling | Playwright cannot reach US: human chooses headed persistent profile with VPN |
| 15 | gate 1 | ruling | approved with three edits: pixel-diff in slice 1, full-page oracle, name the two unaccounted archetypes |
| 16 | slice 1 | process | pushed and opened a PR unprompted: forbidden; verify PR contents; push guard |
| 17 | slice 2 | ruling | vendor BentonSans; tiles are not a GAP while in the T0 DOM |
| 18 | slice 2 | pace | nothing is built after six hours; the shell looks nothing like ESPN; batch modules; step 8 the shell now |
| 19 | slice 2 | tooling | check which tool is used for reference comparison and whether to full potential (found: oracle had no header, CDP deep calls still "deferred: geo") |
| 20 | slice 2 | process | why does it keep stopping; why so many questions; I asked for full automation |
| 21 | slice 2 | scope | pixel to pixel top to bottom on every home page including the footer; this is very important |
| 22 | slice 3 | pace | so many blockers, no UI built, what are the prompts for; build it all |
| 23 | slice 3 | scope | final prompt: Chrome only, implement everything, cross-check three times per element, no questions, ten hours, do not stop even when complete, QA every click, queue every flow |
| 24 | slice 3 | scope | maximise reuse; build the pages in a series |
| 25 | slice 3 | scope | build the Favorites feature end to end with every modal pixel perfect |
| 26 | retro | process | none of the files automated the process or got pixel-to-pixel UI; think about what you messed up |
| 27 | retro | scope | build a Claude skill that uses Playwright CDP and Claude in Chrome for their strengths, explores every flow, builds efficiently, and stores my corrections as training to improve itself; personal use |

`RETRO.md` holds the answers to distill's two questions for this build.
