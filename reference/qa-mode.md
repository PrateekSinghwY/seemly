# QA mode (`run qa`)

Triggered by `run qa`, `qa pass`, a bug sheet handed over, or `DONE` with time left. It runs
the build's QA the way a human tester would, so the defects a tester finds are found first.
Every probe below exists because a tester filed that defect against a finished build and the
build had passed its own gates. A tester-found defect is a missing probe: the fix ships with a
new or tighter row here the same day (section 11 of `SKILL.md`).

Two entry points share one loop:

- **Sweep** (no sheet): every route in the surface graph × every probe in the catalogue.
- **Sheet** (a bug sheet or ticket list): every row in the batch, then the sweep's probes on
  the component each row touched, because a reported defect is rarely alone in its component.

## The loop, per row or per component

1. **Read the row whole.** Summary, path, type, description and every attachment. The row's
   subject is the tester's **path and screenshot**, never its title: read the URLs in the
   screenshots (host and path decide which edition and which page the tester was on) and the
   action they took. A row titled after a modal can be about what the click before it does. An
   attachment that cannot be opened blocks its own row: the row is `BLOCKED` in the batch
   table, said plainly, and nothing that depends on the attachment is touched; never a caveat
   in a status block. Unrelated rows go on: it is not a run-level `BLOCKED` (`SKILL.md`
   section 0 keeps that for its three reasons).
2. **Classify.** fix / excluded (with the human's ruling quoted) / out of scope (scope doc
   cited) / not reproducible (with the evidence) / already correct (with the reference
   capture that proves it). The last two need a capture, never an opinion.
3. **Establish state on both sides.** Signed in or out, has data or empty, first visit or
   consented, owner or member, season phase, and the counts that pick a branch: how many
   entries or items the tester had, the record's per-user limit, its size against the page
   size. Write the row's preconditions down before calling anything a bug or a mismatch. The reference often differs by state. A mismatch
   that is only a state difference is "already correct", with both captures.
4. **Capture the reference fresh**, on the target edition, with the component in every
   state the probes below name. Writes are captured without being made: abort the request
   (the UI shows its failure path) or fulfill it with the expected body (the UI runs its
   success path).
5. **Diff the clone** with the same script at the same width and state: computed styles,
   geometry, text, accessibility tree, requests.
6. **Fix at the source.** Data goes through the seed, copy goes through the copy table, icons
   are extracted (never redrawn), and shared atoms are fixed once for every user.
7. **Verify in the rendered page**, not the seed or the API alone: the response can be
   rewritten between the store and the screen. Re-run the step-5 diff to zero. **A row is
   fixed only when** (a) the tester's path has been replayed click by click on the clone and
   on the reference in the same state, with what happens after each click compared (modal,
   toast, navigation, requests), and (b) the whole surface the row touches has been diffed
   side by side with a reference page in the same state class, every row and column, not
   only the reported symptom. An API proof of the symptom ("the 31st item lands on page 2")
   is evidence for the symptom, never for the row. If the clone's data can't reach the
   tester's state, make it reach that state on a scratch backend, or report the row as
   unverified; never call it fixed.
8. **Record.** Domain fact in its doc, gap in the gaps doc, the human's words verbatim in
   `LOCAL/corrections/<build>/`, and a row added here if no probe would have caught it.
9. **Report the batch** as one table: row, verdict, commit, what was not verified.

## Probe catalogue

Each probe names what to capture on the reference and what to compare. Run every probe that
applies to the component; "applies" is decided by the component's controls, not by the row.

| probe | capture on the reference | compare / rule | origin |
|---|---|---|---|
| **interactive states** | every link, button, card, tab, menu item, map or editor tool toggle: rest, hover, focus-visible, active, pressed, selected, disabled; every checkbox and radio checked, unchecked and indeterminate. Hover through a real mouse path (opener, then down into the panel, then the item); a synthetic hover on an item can close its panel | computed color, background, radius, border, outline, transition, cursor per state. "Looks right at rest" is half a capture. A restyled native control still draws its state glyph (`appearance-none` removes the tick too, leaving state by colour alone) | dropdown item hovered red with a 3px fill; clone underlined; pricelabs/B2, PR18 tool toggles |
| **shared-atom sweep** | when one instance of an atom is wrong, the same atom on two other surfaces | fix the atom once; verify every surface that uses it | one menu link class, five menus |
| **icon source** | the icon's element, its `::before`/`::after` content and font-family, `<use>` target, or `<img>` src | icon font: extract the glyph outline from the font file; sprite: copy the `<symbol>` path; img: vendor the file. Never hand-draw | settings gear, share icons |
| **state-only controls** | each selectable group after one selection, all selected, and cleared; each form after an edit, after an invalid value, after save | header actions (Reset, Clear, Select all), counters, summaries and enabled/disabled submits that only exist in those states; whether their appearance shifts layout | add-ons Reset appeared only after a check |
| **account-state variants** | the surface with and without the user's data (has a team / none, consented / not, owner / member, zero records / one or more: a surface may swap a marketing layout for a table with extra header actions), and the record's own format (a tester may compare two leagues of different formats) | both variants built and chosen by state; a "wrong copy" report checked against the tester's state and record format before changing anything | rail art changes when the fan has a team; a knockout league has no divisions section |
| **one-time prompts** | consent, onboarding, what's-new and first-join modals; their variants and trigger read from the page bundle when the account already passed them | captured by fulfilling the flag response, never by a real write; every variant and its dismiss path (are-you-sure steps) built | consent modal on create |
| **feedback after actions** | every write and copy action: toast, inline bar, lightbox, button relabel, focus move | the message, its colour, duration and placement; a silent success is a defect | copy-link bar, invite success lightbox |
| **validation bounds** | each text input swept with a fixed battery: empty, whitespace only, max length, max+1, symbols only (`!@$%^*`), the tester's exact string, foreign (`£`, accented), HTML (`<b>`, `&`), emoji, leading/trailing spaces; numeric inputs add letters, `e`, negative, decimal, blank. First enumerate each field's **valid** domain (a `0` can be a real category), then fuzz outside it; never fire a case that would create a metered record, and snapshot consumable counters before and after | the reference's verdict and message for every case, recorded as a table; the clone runs the same battery through the server validator and the form (disabled submit, inline error, bottom bar) and must match row for row. A rule inferred from one sample is not done until the battery passes | league name: symbol-only names passed while the comment claimed they were refused; pricelabs/R-M6, PR18 numeric filter |
| **tester's exact input** | the literal value in the tester's screenshot or steps | replayed verbatim in the clone before the row is called fixed; a fix verified only on a nearby value is not verified | league name `!@$£%^&*` |
| **option lists** | every select's full option list: count, first, last, order, label format, default | identical lists (no clone-only options, same order such as `No, Yes`, same date/time/zone format) | pick clock had a 5 s option; trading listed Yes, No; day list 14 days vs two months |
| **cascades** | change each driving control after its dependants are set (type after date, date after time, order after trading) | which dependants reset, which keep, which rows appear or vanish, per value of the driver | a new draft type kept the old date; autopick kept a time row |
| **read-only per variant** | the read-only/summary view for every value of each driving control (patched read when the account cannot hold it) | rows present, row order and value formats per variant | offline summary listed pick clock and order |
| **nav targets** | every nav item's href on the reference and its state in the clone's rendered menu | live exactly when its destination is built; unbuilt stays disabled; a live link that lands on the home page or a near-match is a wrong redirect; a menu under a disabled parent must not open | menu items enabled to built pages only |
| **conditional link tables** | a page whose items come from the bundle's own table (`display:` / `title:` per item): read the table and every helper it calls (resolve imported modules from the main bundle's module array), then list the item states it can produce | evaluate the reference's rules from each seeded record's API read and diff them against the clone's rendered list, for one record per state (before / during / after the event, each format, each flag that renames a title); a destination built after the list was wired is re-linked the same day (grep its path among the disabled links) | LM tools: Edit Keepers stayed disabled after the keepers page was built and showed during a live draft; the trading row never renamed to Stop |
| **mode persistence** | a page with view and edit modes: hard-load each view, click every tab from rest and from edit (clean, dirty + continue, after cancel), and each section's EDIT on the summary | the mode each step lands in and the URL it leaves; a mode the reference keeps across tabs is kept in the clone | edit mode stayed on across tabs on the reference, the clone dropped to read-only |
| **conditional rows** | a form or summary whose rows come from the bundle's per-section row builder: the builder's conditions, then one seeded record per value of each condition | the rendered rows, read-only and edit, against the builder's list for each state (sweep the states through the API on a scratch backend) | waiver rows shown under no waivers; trade rows shown at no trading |
| **side-effect logs** | every write's entry in the app's activity / history / audit feed (header, lines, filters), read from the feed's renderer when the account holds no example | each write in the clone produces the reference's entry, worded by the reference's template table; the feed's filters select the same entries | settings saves wrote no LM action |
| **every owner kind** | a write on records owned by each kind of owner the clone seeds (the fan, another member, a bot) | the write succeeds for each; an ownership echo the read returns is accepted back | team moves refused for bot-owned teams |
| **list chrome** | a list or table page: every column and its order, toolbar controls in order, column-visibility menu, sort per column both ways, pager, totals row | identical columns, toolbar order and sort; column visibility's Select All is tri-state (all, some = indeterminate, none) | dashboard list missing three columns and in another toolbar order; pricelabs/PR18 |
| **bulk selection** | select one row, select the page, select the page twice, select all, clear; the header checkbox and the "N selected" text in each | select-page is idempotent; the header checkbox shows indeterminate on partial; the selection label format ("N Selected") matches; bulk actions appear and enable as the reference's do | select-page toggled off on a second click; pricelabs/PR18 |
| **filter surfaces** | each filter control: its container (inline, popover, side drawer), where its option schema comes from (a request or the bundle), and the request param each control sets | the same container and placement; each control sets its own param (a link filter is not the id filter); the filter narrows **every** view that shows the set (table, map, chart, counts), not only the one it sits on | filter drawer built inline; a filter that narrowed the table and not the map; pricelabs/PR18 |
| **write confirmations** | every write control: the click and the next 5 s, looking for an intermediate confirm, a review step or a dirty-state guard | the clone shows the same confirm with the same copy and buttons before writing; a write that fires on the first click where the reference confirms is the defect | create-from-selection fired without its confirm dialog; pricelabs/PR18 |
| **layering and containment** | tooltips near a container's edge, popovers over sticky bars, the global header while the page scrolls, fullscreen modes | tooltips stay inside their container; the global header and popovers stack above page content; fullscreen keeps the legend and overlays the reference keeps | map tooltip escaped the map; page content scrolled over the header; legend lost in fullscreen; pricelabs/PR18 |
| **panel affordances** | split panes, drawers and rails: drag handles, collapse toggles, previous/next record arrows, a right rail of actions | every affordance present and working; a mounted rail, not only a component file | resizable dividers and prev/next record arrows missing; action rail never mounted; pricelabs/PR18 |
| **date-anchored views** | every view whose window is relative to today (next 60 days, last 30, a range picker with presets) and each aggregate shown beside it | the window is anchored to the environment's frozen date, never the wall clock, on both server and client; aggregates recompute when the range changes; the window options list matches | a 60-day window anchored to the wall clock; an average not recomputed per range; pricelabs/PR18 |
| **no invented hints** | info icons, helper text and tooltips beside headings and fields | the clone carries exactly the reference's; an `(i)` the reference lacks is invented UI | description icons on every chart heading; pricelabs/PR18 |
| **width-driven layout** | the bar or grid at each breakpoint band and at N-1 / N / N+1 of each | overflow rules (how many items inline, what moves to More), column counts | sub-nav overflow into More |
| **motion** | animations a click starts (keyframes, durations, easing, the sequence) | built with `prefers-reduced-motion` honoured | reaction burst |
| **modal behaviour** | open, Esc, outside press (primary button only, not the scrollbar), focus trap and return | each behaviour matched | outside press on modals |
| **disabled treatment** | the control the reference shows that the clone will not build | same icon, geometry and copy; disabled in behaviour, all four together: native `disabled` (or `aria-disabled` plus removal from the tab order only where native is impossible), no handler path that still fires (click, submit, keydown), not-allowed cursor, and never signalled by colour alone; reason text where the reference has one; never an apology toast or a "not available" label in its place; its backend removed only when no other path reaches it | chat dock, share links; pricelabs/B1, AG1 |
| **unattended engines** | a process the server runs on a clock (a draft, an auction, a waiver run): start it, leave its page before it ends, then open only another page of the same record | the other page's read finishes what came due (picks, rosters); nothing waits for its own page to be reopened, and reopening it shows the finished state | draft left after the fan's last pick never completed; My Team stayed empty |
| **automated choices** | the reference's auto behaviour (autodraft, auto-lineup) against its own ranking: the first round's ranks, where each position group lands | the clone's choices follow the same ranking with small variation; no position group taken by every team in the same round | bots drafted at random; every team took K and D/ST in rounds 15-16 |
| **feedback placement** | each write's message across pages: which page shows it, where (bottom bar vs inline vs modal), its colour and how long it stays | the message appears on the page the reference shows it on, in the shared bar, and clears on the reference's timer; a refusal closes its confirm when the reference does | team-page messages inline and permanent; duplicate-claim error inside the modal |
| **path replay** | the tester's exact sequence from their screenshots' URLs: the page, the control, the click, and the next 5 s (frames at 0.3 / 0.8 / 1.5 / 3 / 5 s plus the requests) | the clone does the same thing after the same click: same intermediate steps (consent, picker, confirm), same final feedback. A matching static look with a different click outcome is the defect, not a pass | the join button auto-joined with a toast; the reference ran a consent step first |
| **same-state render diff** | a reference page in the tester's state class (private vs public, below / above one page, member vs not, each record format) next to the clone page in that class | every row and column of the rendered surface: extra lines under a name, row height, pager presence, rank format. Explain every number the tester quotes from the screen (a "25" can be a tied rank, not a row count) before deciding | group page: member names under entries in private groups missed; pager judged on a page of exactly one page-size |
| **per-record gates** | a step or flag found for one record (one game, one league type, one sport): the config field that turns it on, read from each record's own payload | the clone reads the same field per record; a step built from one record's capture is checked on every sibling record before it ships | a consent step built for every game; only one game's config requires it |
| **counter claims** | any claim that a count, size or total does or does not move on a write: a controlled before/after on a quiet target, read from the write's response and a fresh read, repeated once | a count rule comes from a controlled test, never from an older note or a busy record's page watched over time; the doc that said otherwise is corrected in place | large-group size said frozen; a controlled join/leave moved it by one each way |
| **bundle vs live** | a branch read from the bundle (a callout, a notice, a redirect): the live page after the same action | live wins. A bundle branch is a candidate until the live page shows it in that state; one that live does not show is removed, not kept "per the code" | a post-join callout from the bundle never appeared after a modal join |
| **dev-stack freshness** | after a reset or a seed edit, what the running API returns | a reset can leave the server on the old database; reload it and check the response, not the file | menu still served old rows |

## What a QA pass prints

```
QA PASS <n>   scope: <rows or routes>   probes: <n run> / <n applicable>
| row | verdict | evidence | commit | not verified |
```

followed by the list of probes added or tightened in this pass. A pass that added no probe
and fixed defects the human reported has not finished its step 8.
