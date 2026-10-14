# Standing decisions

Every row answers a question the human once had to answer mid-run. The skill reads this
table instead of asking. A ruling that is not here means: take the conservative option,
write an `ASSUMPTIONS.md` row, continue. `distill.md` adds a row for every new ruling.

Format: `| topic | ruling | origin |`. Origin cites the correction or lesson file.

| topic | ruling | origin |
|---|---|---|
| Scope | APP: census everything in scope, slice plan, then every slice to verified. No approval stop for the plan; the plan is written to `RESUME.md` and executed | espn/01 |
| Depth | default: everything reachable under the target URL's own path prefix, recursively, until the graph closes; a root URL means the whole same-origin site. Narrowed only by an explicit `DEPTH` | espn/28 |
| Browser split | Claude in Chrome for discovery and behaviour checks; Playwright + CDP for every capture that must be byte-exact or written to disk; both must reach the same edition and login state or preflight fails | espn/05, espn/09, espn/18 |
| Edition / geo | the edition the human named (or the one their browser shows) is canonical; if only one tool reaches it, stop at preflight and say which needs the route. Never capture a different edition and never spoof headers | espn/11, espn/14 |
| Account | logged out by default. If the human says to proceed logged in: capture, but exclude account-bound modules (avatar menu, favorites, fantasy, "for you", anything keyed to a user id) unless a scope file names them; redact identity (name, avatar, email, ids, cookies) at capture time regardless | espn/10, espn/13 |
| Personal data | never in any file: developer identity, emails (scrub payload values, not just keys), phone, tokens, cookies, account ids. Grep after every page; a hit stops the capture | espn/01, lesson emails-in-values |
| Snapshot | one T0 for all in-scope pages, continuous run, spread recorded; later nodes are T0+n and masked for drift | scrape design |
| Capture filters | block ads and analytics by explicit host list only; never a first-party host; log every blocked request. Globals by deny-list of browser built-ins, never an allow-pattern | lesson blocked-first-party, lesson globals-filter |
| Data source order | hydrated DOM first for server-rendered pages, XHR bodies second, page globals third, public API as second witness only | espn/RECON finding |
| GAP vs data | nothing is a GAP while its content exists in the T0 hydrated DOM; seed from the DOM with provenance `html-hydrated`. A `NOT CAPTURED` verdict must cite an allowed request that returned empty | espn/16, lesson tiles |
| Negative verdicts | a "not detected" surface class or absent control must be probed on every in-scope page before it is recorded | lesson feed-pagination |
| Images | vendored by content hash into the seed assets with a manifest to the original path | espn/D-LOW |
| Fonts | vendor every font file the reference served at T0 by hash; `@font-face` with the same family names and weights; licence note in `discovery/README.md` as an internal-environment decision | espn/17 |
| Ads | reproduce captured slot geometry (often collapsed 0x0); masked in pixel diff | espn/D-LOW |
| Video | poster plus controls from the capture; playback is a declared ceiling | espn/D-LOW |
| Live or polling data | frozen at T0; the refresh endpoint exists and returns the same seeded rows; interval matched | espn/D-LOW |
| Third-party embeds | blocked, geometry kept, declared ceiling | RECON |
| Out-of-scope destinations | real `<a href>` to the repo's standard out-of-scope page; one GAP row per destination group; never `href="#"`, never a dead control | BUILD_PROTOCOL |
| Writes on the reference | only free and reversible, once, to capture the write path, then restored; every one in `DIRTIED.md`. The first write of each kind is a `BLOCKED` naming the write and its restore; `resume` authorises that write and undoing only the row this run created, back to its `DIRTIED.md` pre-state. Paid, sending, publishing, deleting or changing anything the run did not create: never | RL_BUILD 5A, favorites scope |
| Irreversible lane | NEVER FIRE | espn/01 |
| Viewport | 1440x900 at deviceScaleFactor 2 for oracle and clone; the Playwright profile sets it, never trust an MCP resize call, measure and print the actual viewport | espn/13, lesson viewport |
| Pixel oracle scope | whole page: header, sub-nav, strips, all columns, every module, promos, footer, legal. Audit coverage against the full-page PNG; uncovered pixels are an oracle defect | espn/22 |
| Pixel diff | per module, masks from `regions.json`, same Chrome build both sides, refuses to run if the lock differs from the oracle's, never a page percentage | espn/BUILD pixel channel |
| Step 8 | computed-style convergence per element against the capture before anything is called built; behaviour first, then paint | espn/21 |
| Reuse | one component per module archetype; variant is a prop or params row, never a branch on page or league key; one page component, one shell layout; pages after the first are config rows with 0 component changes | espn/BUILD, espn/25 |
| Series order | shell, page component, module library most-shared first, first page verified, then each remaining page as config | espn/25 |
| Batching | build all modules for the first page as one slice, converge each at the end, one fresh-eyes review per batch; per-commit gates and ledger stay | espn/20 |
| Deferrals | every deferral carries a release condition and a check that tests it, re-tested at each pre-slice block; a deferral with no trigger is a defect | lesson deferred-geo |
| Review findings | gate-weakening findings fixed immediately; every other finding pinned to a slice with a release condition, never asked about | espn/23 |
| Pushes | after every slice, `PUSH_OK=1 git push` to the `feat/*` branch, unprompted; never main, never PRs, never force; guard stays installed | espn/19, espn/24 |
| Reporting | to the human only at PREFLIGHT FAILED, BLOCKED, SESSION CHECKPOINT, DONE; everything else to `RESUME.md` | espn/24 |
| Session limits | on low context: finish the atomic step, write `RESUME.md`, print the resume line, stop; a resumed session prints `RESUMED FROM` and continues | espn/RUN_ALL |
| Time budget | if the human names a budget, `DONE` starts QA passes that re-walk every page and click until the budget is spent | espn/26 |
| First visible page | within 2 hours of preflight; a miss is written to `RESUME.md` with the reason, not a stop | retrospective |
