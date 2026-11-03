# LESSONS: espn-standings-teams-players

## L-reset-race (2026-09-25, near-miss, gate catch)
`pnpm reset` failed once with `CircularDependencyError ('card_header','card_image')` in a committed
migration; 3 re-runs and 24 PYTHONHASHSEED runs on a scratch DB all passed. Cause: the dev
backend's reload runs `init_db()` -> `alembic upgrade head` on the same SQLite file, and a
backend edit just before `pnpm reset` makes both migrate at once.
Check (T1, loop): after any backend edit, wait until `/api/openapi.json` answers twice 2 s apart
before `pnpm reset`; a reset failure is re-run once after that wait before it is debugged as code.
Second half: after a reset the running backend can keep serving the deleted DB file (an open
SQLite handle on the old inode): `/api/teams/wnba` said "no teams page" with the new DB seeded.
Check: after `pnpm reset`, one API read of a row the reset just seeded; if it misses, touch
`backend/app/main.py` (reload, not a restart) and read again.

## L-line-height-as-declared (2026-09-25, verify failure → fixed)
Teams index: rows 3 of each first group failed (45 vs 44, ~9%) from a 0.008px drift. The h1's
`leading-[32.2px]` lays out 32.2031 tall; the reference declares `line-height: 1.15` (28px ×
1.15 = 32.19999…), which lays out 32.1953. Same computed value, different LayoutUnit rounding,
and the drift crosses a pixel boundary two rows later.
Check (T2, pix geometry): when a probe shows a fractional line-height, read the reference's
declared value (ratio vs px) and write it the same way. pix.mjs `MOVED`/size lines catch the drift.

## L-leaked-frames (2026-09-25, near-miss ×2)
Twice the shared CDP profile jammed (connect timeouts, a 3 s probe taking 200 s): tool tabs left
open by killed runs, each T0 render loading the saved DOM's static ad iframes (1,317 iframes +
376 workers at the worst). Fix: tools/_page.mjs (one loader: subframes and scripts aborted on T0
renders, close in finally + on SIGINT/SIGTERM, 150 s watchdog); pix.mjs got the same abort rule.
Check (T1, loop): a new look/measure tool imports _page.mjs; before a long pix run, the profile
has < 20 page targets (`curl :9222/json`), else close the tool tabs first.

## L-tabular-nums (2026-09-25, verify failure → fixed)
Roster columns drifted 2px because ESPN's `Table` cells use `font-variant-numeric: tabular-nums`
(digits wider), which changes auto-layout column widths; the clone's shared TH/TD tokens lacked
it. Check (T2): pix geometry's font signature now includes font-variant-numeric; probes of any
text-bearing cell include it.

## L-next-routes-stale (2026-09-25, ×3)
After bursts of file / git changes the Next dev server's route table goes stale: built routes
404 or 500 ("missing required error components"), and pix reports "clone rendered no modules".
Check (T1): before a pix run, curl one built route per template; on 404/500 touch
frontend/next.config.mjs (mtime only, content untouched) and wait for the reload.
- L-tw-leading-normal (2026-09-26): Tailwind v4 `leading-normal` is 1.5, not CSS `normal`; a legacy page's `line-height: normal` needs `leading-[normal]`. Check: grep new legacy components for `leading-normal`.
- L-global-input (2026-09-26): globals.css styles `input` unlayered (width 100%, padding, border, radius, background shorthand), outranking utilities; native-looking fields need `[border:revert]!` etc., image buttons an inline `background`.
- L-json-null (2026-09-26): SQLAlchemy `JSON` stores Python None as the JSON text `null`, so `IS NOT NULL` passes; nullable JSON columns use `JSON(none_as_null=True)`.
- L-inline-script-oracle (2026-09-26): _page/pix block external scripts only; inline scripts in a saved DOM re-run (document.write doubled a link). Strip such scripts into an oracle copy.
- L-api-case (2026-09-26): ESPN's byathlete spells a category `defensiveInterceptions` in the list and `defensiveinterceptions` on athletes: match category names case-insensitively everywhere (parser, service, UI, checker).
- L-partial-records (2026-09-26): a byathlete response omits categories a player has no stats in for that sort; merge categories across every response for an athlete.
- L-new-image-tables (2026-09-26): scripts/check_images.mjs walks named tables only; a new table carrying image paths (stat_page, stat_athlete) must be added there or its images are never vendored.
- L-derive-display-rules (2026-09-26): the front end formats API values (toFixed on totals, made-att pairs); prove display rules against every captured page with a cell-by-cell checker before converging pixels.
- L-shared-next-distdir (2026-09-26, correction 21; supersedes L-next-routes-stale): the recurring ChunkLoadError was scripts/check_renders.mjs spawning a second `next dev` in frontend/ on every commit hook; `next dev` rebuilds `.next` on start, so the developer's running server lost its chunks under open tabs. Fix: the gate runs Next from a throwaway copy of frontend/. Check: overlay/checks.md "No gate shares the dev server's build dir".
- L-disabled-parity (2026-09-26, correction 22): the NBA pillar hover menu showed Schedule / Futures live (redirected to /nba/) while the league bar showed them disabled; the ruling lived in get_league_nav only. Fix: get_nav_tree applies _disable_unbuilt to league pillars. Check: scripts/check_nav_parity.py in verify.sh.
- L-disabled-no-hover (2026-09-26, correction 22): disabled items must take no hover effect and open no flyout; a disabled menu item still opened its flyout. Check: overlay/checks.md "Disabled takes no hover".
- L-menu-hover (2026-09-26, correction 22): the menu column's red hover fill was never converged (only at-rest styles were). Capture rule added.
