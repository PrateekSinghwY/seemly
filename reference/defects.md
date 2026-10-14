# Defect catalogue, this skill's own

Extends `docs/BUILD_PROTOCOL.md` in the target repo with the classes this skill has
already paid for. Read against every slice before it is called done. `distill.md`
appends rows.

| class | rule | seen in |
|---|---|---|
| **Method before page** | verify the environment in ten minutes and get one page rendering real data before adding rigor; rigor after a page exists, not instead of it | espn retrospective |
| **Filter defines the evidence** | never an allow-pattern on globals, hosts or selectors; deny-list and log what was dropped | globals `__` filter, blocked first-party auth |
| **Absence read as fact** | a module empty in the capture is a capture question first; `NOT CAPTURED` must cite an allowed request that returned empty | scores strip tiles |
| **One probe generalised** | a negative verdict from one page is not a verdict for five | feed pagination |
| **Rule copied, then drifted** | one definition per exclusion rule, imported everywhere; six drifts in one build | A2 selector |
| **Wrong granularity match** | substring matches on ids or headings swallow real content (`[id*=fav]` ate the legal footer, heading test ate articles) | A2 heading, favfeed-footer |
| **Oracle blind to the slice** | the pixel oracle must cover the whole page, header to footer, audited against the PNG | shell had no clip |
| **Built but never mounted** | a component not imported by the page is dead code marked done | slice 2 |
| **Stale process mistaken for the build** | a server already on the port predates your changes; start your own on a free port | Tailwind emitting nothing |
| **Vacuous green** | a check that exits 0 having checked nothing; every check writes `ran` and a count | check_a2_assets, page_complete without app |
| **Hook discards status** | a hand-edited git hook swallowed the sweep's exit code; hooks come from the tool-managed config | pre-push |
| **Deferral without release** | a deferral with no trigger stays blocked forever; every one carries a check re-tested per slice | deferred: geo |
| **Scrub keys, not values** | identity lives in values too (46 journalist emails in payload values) | scrape Part 3 |
| **Seed path skipped a rule** | one table (assets) bypassed the exclusion every other table applied | 132 rail images |
| **Screenshot as truth** | a shell built from how the screenshot looked, not what the capture measured: 68 property diffs | slice 2 step 8 |
| **Reporting is stopping** | every progress message to the human is a turn end; report to files, speak only at gates and blocks | whole build |
| **Ruling made reactively** | each mid-run question was a missing row in decisions.md | whole build |
| **Both tools, different worlds** | Chrome on one edition, Playwright on another; both must match at preflight | geo split |
| **Resize trusted** | an MCP resize reported success while the page measured the old width; measure in-page | 1920 vs 1440 |
| **Literal in examples** | captured strings leaked into OpenAPI field examples | slice 2 gate catch |
| **Fresh-eyes skipped** | two slices called done without the no-context review; it later found 39 findings including nothing mounted | slice 1, 2 |
| **Push on own initiative** | pushing and opening a PR without being asked; now push to feat/* is allowed, PRs are not | slice 1 |
| **Matched at rest, called built** | pixels at one width and at rest were read as a finished module; overlays, replays and strips behind clicks were never opened | fb/54-58 |
| **Static tree** | the graph was treated as closed after the first walk; clicks found later were never queued | fb/54 |
| **Contextual shell built once** | a header strip built from the home capture was reused on every template; the reference changes it per section and date | fb/54, fb/64 |
| **Width of one** | every check ran at 1440; overflow at 1024 and a left-pinned layout above 1440 shipped | stp/40, fb/54 |
| **Hand-added list item** | a capture tool appended an invented tab to a captured list; the delta was logged as a gap instead of fixed | stp/40 |
| **Shared stand-in** | an image budget gave two teams one crest and two players one face; path checks passed, a person saw it at once | stp/37 |
| **Stand-in with meaning** | an image chosen to mean something (a followed team's photo) resolved to a budget stand-in of another entity | stp/39 |
| **Rendered but inert** | a rendered player showed a disabled Follow because the seed had no row for a card-only entity | fb/65 |
| **Wiring after the fact** | a write control was built without its round trip; the human found the surfaces that did not update | fb/63, fb/64 |
| **Disabled that looks live** | a disabled item kept its hover fill, opened its flyout, or carried the active underline; the same link was live on one surface and grey on another | stp/22, fb/50 |
| **Empty section printed** | a heading printed with nothing beneath it | fb/51 |
| **Wrong module for the state** | a scoring-plays view rendered the all-plays accordion instead of the reference's scoring cards | fb/58 |
| **Chart focus ring** | a mouse click on a chart drew a focus outline and a native tooltip | fb/59 |
| **Silent utility drop** | a malformed arbitrary utility generated no CSS; every card lost its shadow with no error | fb shadow lesson |
| **Exclusive breakpoint** | a `max-[N]` rule is `< N`, so "N and below" missed exactly N; verify at N-1 / N / N+1 | stp 2026-09-27 |
| **Unlayered global wins** | an unlayered global rule beat layered utilities, so `hidden` did nothing | stp 2026-09-27 |
| **Href join on a slug** | a join on a captured href's slug silently matched nothing; join on the stable id parsed from the href | stp 2026-09-27 |
| **Gate shares the dev build dir** | a render gate started a second dev server in the developer's frontend folder and wiped their chunks on every commit | stp/21 |
| **Test on the human's data** | a write test pointed at the human's stack deleted real favourites; write tests refuse the main ports | fb 2026-09-29 |
| **Names in test data** | click traces stored athlete names in labels and slugs; the external names check failed the PR | fb 2026-09-27 CSync |
| **Builder collisions** | three builders picked one migration id and two designed one table differently; contracts were not fixed up front | fb 2026-09-29 |
| **Ruled-out work briefed** | a builder was briefed to build a destination the human had ruled out | fb/68 |
| **Second PR** | a new PR was opened for work that belonged on the open one; a stray database file was committed and the PR body did not match the diff | stp/44, stp/45 |
| **JSON null is not SQL NULL** | an ORM JSON column stored None as the JSON text `null`, so `IS NOT NULL` passed; nullable JSON columns store SQL NULL | stp L-json-null |
| **Captured path in a tracked list** | an image allowlist stored captured paths verbatim, and the paths carried athletes' names; the external names check failed the PR. Tracked references to captured data use an id or a hash | fb/77 |
| **Rest-state capture** | a component captured only at rest ships without its hover, focus and selected states; capture every state through a real mouse path (`qa-mode.md` interactive states) | bug sheet 2026-10-06: dropdown hover |
| **Hand-drawn icon** | an icon redrawn by eye differs from the reference's glyph; extract the font glyph or sprite symbol path | bug sheet 2026-10-06: settings gear, share icons |
| **State-only control missed** | controls that appear only after a selection or an edit were never captured; capture after select-one, select-all, clear | bug sheet 2026-10-06: add-ons Reset |
| **State variant read as a bug** | a tester's account in another state (no data, not consented) sees another variant; establish state before changing copy or art | bug sheet 2026-10-06: rail art |
| **One-time prompt unobservable** | a consent or onboarding modal already passed on the test account; read variants and trigger from the bundle, capture by fulfilling the flag | bug sheet 2026-10-06: consent modal |
| **Fixed the symptom, not the atom** | one reported instance fixed while the shared atom stayed wrong elsewhere | bug sheet 2026-10-06: dropdown links |
| **Seed right, screen wrong** | a seed edit verified in the file or DB while the API rewrote it (a build rule, or a server on the old database); verify the rendered page | bug sheet 2026-10-06: nav items |
| **Attachment unopened** | rows fixed without opening their attachments; an unreadable attachment blocks its own row (BLOCKED in the batch table) | bug sheet 2026-10-06 |
| title-not-path | verify a re-opened row against its title or the component's look | replay the tester's path from the screenshot URLs and compare what each click does (qa-mode path replay) | QA 2026-10-12, join flow re-opened twice |
| symptom-only-proof | a row called fixed because the API shows the reported symptom gone | the rendered surface diffed side by side with a reference page in the same state class, every row and column | QA 2026-10-12, group standings missing member names |
| one-record-gate | a step captured on one record applied to every sibling record | read the enabling field from each record's own config | QA 2026-10-12, consent step on a game that has none |
| stale-count-note | trusting an older note that a count never moves | a controlled before/after on a quiet target; supersede the note in place | QA 2026-10-12, large-group size |
| bundle-branch-shipped | building a branch read from the bundle without seeing it live | live decides; remove what live does not show in that state | QA 2026-10-12, post-join callout |
