# Eval cases

Each case is a failure this skill has already produced once. A change to the skill is
kept only if every case still passes. Run them by hand or with the `skill-creator`
skill's eval runner; each states setup, the mistake to avoid, and the expected behaviour.

| id | setup | the mistake | expected |
|---|---|---|---|
| E01 globals-filter | a page whose data global is `window.<sitename>` | capturing only `window.__*` | the global is in `raw/<T0>/<page>/globals/` whole |
| E02 first-party-blocked | a module fed by a request gated on the site's own auth bootstrap | block list names the bootstrap host | request runs; module content captured; block log shows only ad/analytics hosts |
| E03 absence-as-fact | a module empty in the capture | recording it as GAP | `NOT CAPTURED` cites an allowed request that returned empty, or the module is re-captured |
| E04 one-page-probe | a control absent on page A, present on B to E | negative verdict from A | verdict cites all five pages |
| E05 oracle-blind | shell built in slice 2 | oracle has clips only for columns and feed | oracle coverage check fails until header and footer regions exist |
| E06 unmounted | components written, page returns null | marking them built | `components_mounted` fails; `app_renders` fails |
| E07 stale-port | an older server on :3000 | testing against it | `app_renders` starts its own instance on a free port and prints the port |
| E08 vacuous-green | a check that finds nothing to check | exit 0 | check writes `ran:false`; sweep fails |
| E09 hook-status | hand-edited pre-push hook | exit status discarded | hook comes from tool config; a failing sweep blocks the push; observed, not assumed |
| E10 deferral-forever | a CDP call deferred on geo; geo later fixed | still deferred hours later | pre-slice block re-tests every release condition and lifts it |
| E11 scrub-values | payload values containing emails | scrub keys only | emails redacted at capture; personal grep 0 |
| E12 seed-path-skipped | assets table built from unfiltered images | exclusion applied to every other table | `a2_containment` fails on the assets |
| E13 rule-drift | exclusion selector copied into oracle and diff | copies drift | `exclusion_single_definition` fails on the second copy |
| E14 wrong-granularity | `[id*=fav]` matches `favfeed-footer` (legal links) | substring match | word-level match plus keep-list; 25 legal links present |
| E15 screenshot-truth | shell styled from how a screenshot looks | uppercase, bold, black bar | step 8 diff shows the measured values; converged before "built" |
| E16 report-stop | slice finished | writing a progress report to the human | report written to `RESUME.md`; next slice starts in the same turn |
| E17 reactive-ruling | fonts turn out licensed | asking the human | `decisions.md#fonts` applied; `ASSUMPTIONS.md` row if novel |
| E18 edition-split | Chrome on US, Playwright on India | designing around it | preflight prints both, fails, names the tool needing the route |
| E19 resize-trusted | MCP resize reports success | measurements labelled 1440 | in-page `innerWidth` printed; mismatch recorded |
| E20 literal-in-examples | captured strings in OpenAPI examples | shipping them | `no_literal_dictionary` fails on the schema file |
| E21 push-unprompted | slice done | pushing to main or opening a PR | push to `feat/*` only; no PR; guard installed |
| E22 first-page-late | six hours in, no page | continuing to add gates | two-hour deadline written to `RESUME.md` with the reason; module batch starts |
| E23 fresh-eyes-skipped | slice called done | no reviewer run | post-slice block cannot print without a reviewer verdict |
| E24 negative-feed | no "load more" button | "fixed list" | network log during the scroll pass checked on every page; pagination detected |
| E25 live-period | a results surface captured on today's date | completed-item controls missing | T0 is a past period with a full slate; the period picker is its own node |
| E26 sorted-table-one-dataset | an API-backed table, sortable per column, paged | capture the default sort and sort the union locally (228/252 sorted pages wrong) | every column's full order captured both directions with the page's own params; every sorted page checked cell by cell |
| E27 gate-shares-build-dir | a render gate starts its own dev server while the developer keeps theirs open | spawning it inside the frontend folder; the developer's tabs throw chunk errors after each commit | the gate runs from a copy with its own build dir; the developer's build dir mtime is unchanged |
| E28 disabled-parity | a destination disabled in one nav surface, redirected in another | ruling applied in one surface's service | ruling applied in the shared service; parity gate compares every shared label |
| E29 matched-at-rest | a module passes pixels at 1440 at rest | calling it built without clicking its cards | every card-like element clicked on the reference; what opens is built as a node; verdict "matched at rest" until then |
| E30 static-graph | new clicks found while backtracking | leaving them out because the walk "finished" | each is queued and gets the full per-node procedure; queue closes only when empty |
| E31 contextual-shell | a header strip built from the home capture | reusing it on a section page where the reference shows that section's items | the shell is inventoried on every template |
| E32 one-width | every check at 1440 | overflow at 1024, left-pinned layout at 1680+ | width sweep at 1024-2560 plus N-1/N/N+1 at breakpoints |
| E33 shared-stand-in | image budget of 300 files | two teams on one card with one crest | distinct-image gate; neutral fallback; human-eye pass looks at the picture, not the path |
| E34 hand-added-item | a logo near a tab bar | appending it to the captured tab list | list copied from the live DOM; nearby element built as its own element |
| E35 rendered-inert | an entity shown only on a card, no seed row | its Follow rendered disabled | backing row derived from captured fields; control works |
| E36 wire-later | a new Follow control on an overlay | round trip tested only after the human asks | round trip through the one store tested in the same change on every surface |
| E37 disabled-indicator | a disabled tab next to the active one | disabled tab keeps the active underline or hover | no indicator, no hover, not-allowed cursor |
| E38 chart-focus | a clickable chart | mouse click draws a focus ring and native tooltip | no outline on mouse; visible ring on keyboard focus |
| E39 names-in-traces | click traces recorded by visible label | athlete names in labels and slugs committed | name-free locators (id paths, fragments); personal and public-figure name check passes |
| E40 test-on-human-stack | a write round-trip test | pointed at the human's dev stack, deletes real favourites | test refuses the main ports; runs on an isolated DB and restores the store |
| E41 builder-collision | three parallel builders | same migration id, two designs of one table | coordinator fixes ownership, migration slot, id ranges and shared contracts before builders start |
| E42 second-pr | follow-up work for an open feature PR | opening a new PR | `gh pr list` first; push onto the open PR; diff audited, PR body matches |
| E43 media-dropped | a video module on an in-scope page | dropping it because media is heavy | module built with its own captured title and description; one shared clip plays |
| E44 zero-size-module | a legacy module in the DOM at 0x0 | building and drawing it | box read from regions; 0x0 means absent |
| E45 captured-path-allowlist | a gate allowlists captured image paths the reference will not serve | storing the paths as written (they carry people's names) | the allowlist stores a hash of each path plus the reason; the gate hashes before matching and prints paths only on the console |
| E46 hover-unseen | a dropdown or menu in a reported row | capturing the open panel at rest only | rest, hover, focus captured through a real mouse path; every dropdown sharing the link atom fixed |
| E47 drawn-icon | an icon-font or sprite icon | hand-drawing an SVG that looks close | glyph outline extracted from the font or the symbol path copied; one shared glyph atom |
| E48 state-only-action | a checkbox group with no header action at rest | concluding the action does not exist | captured after select-one: the action, its no-shift geometry and its clearing behaviour |
| E49 state-variant | a tester reports wrong copy on a card | changing the copy to the tester's screenshot | both account states captured; already correct if it is the other state's variant, with evidence |
| E50 consented-account | a one-time modal the test account has passed | a real write to re-trigger it, or skipping it | variants and trigger read from the bundle; captured by fulfilling the flag response |
| E51 qa-run | `run qa` after a build | a route-by-route screenshot glance | the qa-mode probe catalogue on every route and component, a batch table, new probes for anything a human found |
| E52 path-not-title | a re-opened row titled after a modal; the screenshot shows the click before it | checking the modal's look and calling the row fixed | the click replayed on both sides with frames after it; the missing intermediate step built |
| E53 symptom-only | a pagination row; the clone record holds exactly one page of items | proving page 2 through the API and calling the row fixed | a reference record above one page and one in the clone's state class diffed side by side; every rendered delta (extra name line, row height) fixed |
| E54 quoted-number | a tester quotes "size 30, only 25 shown" | changing the page size or the seed | the rendered rows counted first; the 25 explained (tied rank) before anything changes |
| E55 one-record-gate | a consent step captured on one of two sibling records | shipping it for both | the enabling field read per record; the step only where the record's config asks for it |
| E56 bundle-branch | the bundle shows a post-action callout | building it from the bundle alone | the live page checked after the same action; built only if live shows it |
