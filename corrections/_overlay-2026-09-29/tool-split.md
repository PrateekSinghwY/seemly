# Tool split, learned (overlay; wins over reference/tool-split.md)

Evidence from espn-scores + espn-standings-teams-players (2026-09-24/25). Use each tool for
what it did best; when one fails at a task, switch to the other and log it in
discovery/tool-fallbacks.md.

| task | tool | evidence |
|---|---|---|
| Seeing a hover / open menu / popover as a user sees it | **Claude in Chrome** (hover + screenshot) | The Teams dropdown: four Playwright attempts (hover, click, element and viewport screenshots) captured the page without the menu, because the screenshot moved focus and the menu closed on blur; one Chrome hover + screenshot showed it at once. |
| Finding a control by what it is ("the Teams item in the league bar") | Claude in Chrome `find` | Resolved the right element where CSS selectors hit a hidden global-nav twin. |
| Reading page state that contains URLs with query strings, cookies or ids | **Playwright** | Chrome MCP refused JS output carrying query strings (`[BLOCKED: Cookie/query string data]`). |
| Network: which request a control fires, its exact query, the response body | **Playwright** (`page.on('request')`, `fetch` in page) | Standings pill -> `apis/v2/.../standings?type&level&sort` found and every response captured to disk. |
| Bulk capture (hundreds of pages' server data, API responses) | **Playwright** (in-page `fetch`, ~1 s/page) | 240 team-tab payloads in minutes; full screenshot capture is ~30 s/page, keep it for the oracle subset. |
| Computed-style / geometry measurement, font diff, pixel diff | **Playwright over CDP**, same Chrome build both sides | Every convergence number in both builds. |
| Anything that must be written to disk | Playwright | Chrome MCP cannot write files and truncates large output. |
| Quick visual sanity of the clone after a change | Claude in Chrome screenshot | Fast, real rendering, no script. |
| Clicking through a flow a user would (menus, selects) to confirm behaviour | Claude in Chrome | Real events in the real profile; Playwright for the replayable golden trace. |
| Tailwind v4 in a legacy-design page | `leading-normal` is 1.5, not CSS normal; unlayered global element rules outrank utilities (use `!` or `revert`) | lessons L-tw-leading-normal, L-global-input (espn-standings-teams-players) |
| A gate that renders the app (its own Next on a free port) | run that Next from a throwaway copy of frontend/ (sources copied, node_modules symlinked), never from frontend/: `next dev` rebuilds its distDir on start, so a second one in frontend/ wipes the developer's running server's `.next` and every open tab throws ChunkLoadError / renders empty. distDir lives only in next.config, which is never edited | lessons L-shared-next-distdir (supersedes L-next-routes-stale), correction 21 (espn-standings-teams-players) |
