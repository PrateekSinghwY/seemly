# RL_BUILD.prompt.md

Reusable master prompt. Works for any reference app, any archetype, any scope.
This prompt lives in `never_to_be_pushed/`. Invoke it from the repo root by saying
"Read never_to_be_pushed/RL_BUILD.prompt.md and follow it" — do not paste it. Attach your
screenshots in that same message.

**Only Part 0 is edited. Everything from Part 1 down is fixed method. Do not edit it,
do not summarise it, and do not skip a Part because the target "looks simple."**

---

# PART 0 — INTAKE (you run this. Do not hand me a form to fill in.)

When this prompt is read, your first job is a **short intake interview**. Do not start
capturing. Do not ask me to fill in a template. Do not ask me one question at a time.

## Preflight: prove both tools are live before anything else (STRICTLY ENFORCED)

This run needs **both** Claude in Chrome and Playwright with a CDP session, end to end.
Run every check, print the result, and **never print a ✓ for a check you did not
execute.** If a required check fails, stop, print the fix, and wait.

**Check 1. Claude in Chrome MCP.** The `mcp__claude-in-chrome__*` tools are in your tool
list, and `tabs_context_mcp` returns a tab list. Also `claude mcp list` in Bash shows the
Chrome server connected.

**Check 2. Playwright and Chromium.**
```bash
node -e "console.log(require('playwright/package.json').version)" \
  || echo "PLAYWRIGHT MISSING: run  npm i -D playwright && npx playwright install chromium"
npx playwright install --dry-run chromium 2>&1 | head -3
```

**Check 3. A CDP session opens and answers.**
```bash
node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext();
  const p = await c.newPage();
  const cdp = await c.newCDPSession(p);
  const v = await cdp.send("Browser.getVersion");
  const r = await cdp.send("Runtime.evaluate", { expression: "1+1", returnByValue: true });
  console.log("CDP OK", v.product, "eval:", r.result.value);
  await b.close();
})().catch(e => { console.error("CDP FAILED", e.message); process.exit(1); });
'
```

**Check 4. Auth.** `never_to_be_pushed/discovery/auth.json` exists and loads as a Playwright `storageState`
with at least one cookie for the target's domain. If RECON ran, it is there. If not, the
human logs in once by hand and you save it. Never script a login.

**Check 5. Exclude guard.** `grep -x 'never_to_be_pushed/' .git/info/exclude` returns a line. If
not, run 0.1 step 6 now.

Print exactly:

```
PREFLIGHT
  claude-in-chrome MCP   ✓ connected, <n> tabs         | ✗ ABSENT
  claude mcp list        ✓ chrome server listed         | ✗ not listed
  playwright             ✓ <version>                    | ✗ missing
  chromium               ✓ installed                    | ✗ run npx playwright install chromium
  CDP session            ✓ Browser.getVersion + eval ok | ✗ <error>
  auth.json              ✓ <n> cookies for <domain>     | ✗ missing, need one manual login
  exclude guard          ✓ never_to_be_pushed/ excluded | ✗ set now
```

**Both tools are required.** Playwright plus CDP does every capture in Parts 2 to 6.
Claude in Chrome is how you poke the live app in the authenticated profile when a
precondition cannot be replayed, how you confirm a destination without burning a capture
run, and how you re-export `auth.json` when the session expires mid-run. Losing either
one silently is how a twelve-hour run produces a spec with a hole in it.

**Re-check mid-run.** Before Gate 1 and before Gate 2, re-run Checks 1 and 3 and print the
two lines. Sessions drop. A run that continues after its browser died is capturing
nothing and reporting success.

Only when every row is ✓ do you continue.

## 0.0 If `never_to_be_pushed/discovery/RECON.md` exists, the intake is already done

Check first. If `RECON.prompt.md` has already run, `never_to_be_pushed/discovery/RECON.md` holds sections
1 to 10 that map one-to-one onto the intake below, with evidence, plus the screenshots it
took under `never_to_be_pushed/discovery/recon-shots/` and an `auth.json`.

In that case:

1. Read `RECON.md` fully. Treat sections 1 to 10 as my answers to intake fields 1 to 10.
2. Read the surface census preview, the route table, and the corpus match. They replace
   most of 0.1.
3. **Print only the DOUBTS section**, HIGH first, each with its options and RECON's
   default. Ask me to answer those and nothing else. If DOUBTS is empty, say "RECON
   found no doubts, running on its defaults" and go straight to 0.5.
4. Skip 0.2 entirely. Do not re-ask anything RECON answered. If you disagree with a RECON
   answer, say so in one line under the doubt list as a new doubt, with your reasoning,
   and let me decide.
5. Still run 0.1 step 6 (the exclude guard), then 0.5.

If `RECON.md` is older than 7 days or the target URL in it does not match what I said,
tell me and ask whether to trust it or re-run recon. Do not silently use a stale one.

If `RECON.md` does not exist, continue with 0.1 as written. Consider suggesting, in one
line, that I run `RECON.prompt.md` first next time.

## 0.1 Do your homework before you ask anything

Silently, in this order:

1. `ls` and `git log --oneline -20` the repo. Read `AGENTS.md`, `CLAUDE.md`,
   `docs/DOMAIN_NOTES.md`, `docs/domain/KNOWN_GAPS.md`, and any `never_to_be_pushed/discovery/README.md`.
2. Read `../rl_components/rl-corpus/INDEX.md`, `CALIBRATION.md`, `README.md`, and the
   records for whichever archetypes look plausible.
3. Inventory what already exists: routes built, endpoints in `/api/openapi.json`,
   migrations applied, components present, `e2e/` traces, `never_to_be_pushed/discovery/` artifacts.
4. Look at every screenshot I attached, properly.
5. If a URL appears anywhere in my message, in `DOMAIN_NOTES.md`, or in `never_to_be_pushed/discovery/`,
   open it **read-only** and run a 60-second recon: framework, route manifest, visible
   surface classes from Part 3, third-party scripts, whether an auth wall blocks you.

6. **Protect the discovery artifacts from ever being committed.** Everything this prompt
   generates lives under `never_to_be_pushed/discovery/`. Before writing a single file there, run:

   ```bash
   # per-clone, never tracked, never pushed, invisible to reviewers
   grep -qx 'never_to_be_pushed/' .git/info/exclude 2>/dev/null || echo 'never_to_be_pushed/' >> .git/info/exclude

   # belt and braces: refuse a commit that force-adds anything under never_to_be_pushed/
   cat > .git/hooks/pre-commit.discovery <<'EOF'
   #!/bin/sh
   if git diff --cached --name-only | grep -q '^never_to_be_pushed/'; then
     echo "refusing: never_to_be_pushed/ artifacts are local-only and must never be committed" >&2
     exit 1
   fi
   EOF
   chmod +x .git/hooks/pre-commit.discovery
   ```

   If a `pre-commit` hook already exists (the org scaffold installs one), do **not**
   overwrite it. Append a line that calls `.git/hooks/pre-commit.discovery`, or tell me
   the hook is managed by a tool and hand me the one-line addition instead. Never touch
   `.gitignore` for this: that file is tracked, and editing it is a diff.

   The corpus is the one exception and it lives in a different repo on purpose. Part 8
   writes to `../rl_components/rl-corpus/`, which **is** meant to be committed and pushed.

You now know most of the answers. **Ask only what you genuinely cannot determine.**

## 0.2 Ask once, in one message

Print the block below with your findings pre-filled as `[you: ...]` and your open
questions marked `[?]`. I answer in **one free-form message**, in any order, as long or
as short as I like. Everything I skip takes the default you stated.

```
════════════════════════════════════════════════════════════════════════
INTAKE. Answer in one message, any order, as much detail as you want.
Anything you skip, I use the default shown.
────────────────────────────────────────────────────────────────────────
1  TARGET                                                      [BLOCKING]
   What are we building? A URL, a screen name, or "the whole app".
   >

2  SCOPE                                                       [BLOCKING]
   [you: leaning COMPONENT|APP because ...]
   APP        census everything, produce a slice plan, stop for approval
   COMPONENT  one named surface, all the way to verified
   >

3  HOW TO REACH IT
   [you: ...]
   Clicks from the landing page, or the direct URL.
   >

4  LOGINS AND ROLES
   [you: found never_to_be_pushed/discovery/auth.json for <role> | none found]
   Which roles do you have? Where do the credentials live?
   Never paste a secret here. Tell me where it lives, or log in once by hand.
   >

5  WHAT YOU ARE GIVING ME
   [you: <n> screenshots attached, they appear to show ...]
   Anything else? Recordings, a HAR, an export, docs URLs, pushed code.

   Worth attaching, because I cannot get these myself:
     - states I cannot reach (a populated list when your account is empty,
       an error state, a paid or higher tier)
     - a role you have but I have no login for
     - anything behind a flow that costs money or spends a credit
     - a screen behind an auth wall automation cannot pass

   Not worth attaching: screens I can just open. I read the live DOM far
   better than I read a PNG. Save your effort for the list above.
   >

6  WHAT YOU ALREADY KNOW
   [you: repo already has <...> built; KNOWN_GAPS lists <...>]
   Behaviours you have noticed. Things deliberately disabled. Things known
   broken. Anything the team pushed that I should wire rather than rebuild.
   >

7  IRREVERSIBLE OR METERED ACTIONS
   [you: candidates found in the bundle: <...>]
   Confirm, correct, add. Then pick a policy:
     NEVER FIRE  (default)  |  FIRE ONCE AT THE END, ASKING ME FIRST
   >

8  FIDELITY BAR                                  [default: MAXIMUM]
   MAXIMUM (four-channel parity) | HIGH (visual + behavioural) | FUNCTIONAL
   >

9  CONSTRAINTS
   [you: stack from AGENTS.md is <...>]
   Anything not to touch. Deviations already agreed. Time budget.
   >

10 DONE MEANS               [default: Part 7 termination, all four conditions]
   In your words, if it differs.
   >
════════════════════════════════════════════════════════════════════════
```

## 0.3 Derive these. Never ask me.

| Field | Where you get it |
|---|---|
| stack, conventions, validation tiers | `AGENTS.md` |
| archetype | the Part 3 surface census, not a guess |
| band and cost estimate | `../rl_components/rl-corpus/CALIBRATION.md` |
| known traps | `../rl_components/rl-corpus/archetypes/<name>.md` |
| route table | the framework's own manifest |
| enums, strings, endpoints, shortcuts, flags | the shipped bundle |
| what is already built | the repo, the OpenAPI, the migrations |
| third parties to block | the script list on the live page |
| deliberate deviations already in force | `docs/DOMAIN_NOTES.md` |
| what is not built | `docs/domain/KNOWN_GAPS.md` |

Asking me something on this list is a mistake, not thoroughness. It tells me you did not
do 0.1.

## 0.4 Blocking versus defaulted

**Only fields 1 and 2 block.** Everything else has a default you must state and proceed
with. If I answer "the reports page, component" and nothing else, that is a complete
answer and you run.

If field 1 is a URL you cannot open (auth wall, hard redirect), say so in the intake
message rather than after, and tell me which of the two paths we are on: log in once by
hand, or screenshots become truth.

## 0.5 Echo, confirm once, then go

Print the completed input block with every field filled, defaults marked `[default]` and
inferences marked `[inferred]`. Then ask exactly one question:

> Go, or correct anything above?

On "go" you are **unattended until Gate 1**. Do not re-confirm. Do not check in.

## 0.6 The unattended contract

After I say go, do not ask me anything until a gate. Three exceptions only:

1. An item in `irreversible.jsonl` is about to fire. Always ask, every time, regardless
   of the policy in field 7.
2. A credential or an account you do not have and cannot proceed without.
3. A decision where **every** available path is destructive or irreversible.

Everything else ambiguous becomes a recorded line in `never_to_be_pushed/discovery/ASSUMPTIONS.md`:

```
| # | Assumption | Why I chose it | What it affects | Confidence |
```

Those surface at the next gate. **Never stall a twelve-hour run on a question I am not
awake to answer.** A stated assumption I can correct at a gate is worth more than a
blocked run.

## 0.6.1 If I speak while you are running

The unattended contract binds you, not me. I may interject at any time. Handle it by
the first word of my message:

**`NOTE:`** (or anything that is not `STOP`). Record it verbatim in
`never_to_be_pushed/discovery/NOTES.md` with a timestamp and the exact loop step you
were on. Reply in one line: "Noted at <step>, will address at Gate <n>." Then continue
without breaking the current interaction. If the note names a state, a screenshot, or
a behaviour, add it to `queue.jsonl` immediately so it is captured in this run, and say
so in that one line. All notes are printed at the top of the next gate, before the
gate's own summary.

**`STOP`**. Finish the current atomic step so nothing is left half-written: complete
the capture you are in, or finish and seed the migration you are in, or finish the
persistence check you are in. Never leave a migration applied but unseeded, a snapshot
without its after-state, or a golden trace half-committed. Then halt, print exactly
where you stopped and what is resumable, and wait. Do not begin any new interaction.

**Treated as `STOP` regardless of wording:** anything about the irreversible lane, the
credit, or the target being wrong.

## 0.7 Screenshot precedence, non-negotiable

My screenshots tell you **which screens matter** and **which states I care about**. They
are *not* your styling source when the reference app is reachable, because a screenshot
is a lossy render and a model reading one guesses `#3B82F6` when the answer is `#2563EB`.

- Reference reachable → CDP computed styles are truth, screenshots are the shot list.
- Reference unreachable (hard redirects, unautomatable auth) → screenshots become truth,
  your **first output is a written `never_to_be_pushed/discovery/SPEC.md`**, and you record the reason in
  `never_to_be_pushed/discovery/README.md`. This is the only sanctioned screenshots-as-truth path.
- Anything not visible in a screenshot and not reachable: **ask me for another
  screenshot at the intake or at a gate. Never invent UI from memory of what the app
  "probably" looks like.**

**SCOPE note.** `APP` means census the entire application, produce a slice plan, and
**stop at Gate 1** for my approval before building anything. Use it when initialising a
new RL repo. `COMPONENT` means one named surface: census it, then go all the way to
verified, recursing into every descendant. Use it for day-to-day work.

---

# PART 1 — READ THE CORPUS FIRST

Before touching the target:

1. Read `../rl_components/rl-corpus/INDEX.md`, `CALIBRATION.md`, and `README.md` there (fall back to a `rl-corpus/` sibling if the parent-dir clone is absent, per AGENTS.md).
2. Read every `../rl_components/rl-corpus/records/*.md` for the same archetype as this target.
3. Read the repo's `AGENTS.md` and `docs/DOMAIN_NOTES.md`. **`AGENTS.md` always wins over
   anything in this prompt.**

Then print a short block before doing anything else:

```
PRIOR ART
  archetype guess:            <name>, from <what signal>
  closest past builds:        <target> (<band>, <what it cost>), <target>, ...
  traps loaded from corpus:   <n> (list them by name)
  cost model says:            <band>, <estimate>
  known ceilings for this archetype:
```

If the corpus has no record for this archetype, say so explicitly. You are the first
build under it, and Part 8 requires you to seed one.

---

# PART 2 — DETERMINISM LOCK

Do this before the first capture. Not after the first confusing diff.

```
Emulation.setDeviceMetricsOverride     1440x900, deviceScaleFactor 2
Animation.setPlaybackRate              0
Network.emulateNetworkConditions       fixed values, not "no throttling"
Network.setBlockedURLs                 analytics, session replay, in-app guides,
                                       chat widgets, ad tags
Page.addScriptToEvaluateOnNewDocument  freeze Date.now, performance.now, Math.random,
                                       crypto.randomUUID, and the Intl timezone
inject CSS                             *,*::before,*::after{transition:none!important;
                                       animation:none!important;
                                       caret-color:transparent!important}
await                                  document.fonts.ready
```

Auth: load `never_to_be_pushed/discovery/auth.json` (`storageState`). If it does not exist, **stop and ask
me to log in once by hand.** Never script a login, never attempt a captcha or an OTP.

**Gate 0, self-checked, no human needed.** Capture the same state twice and diff.
Byte-identical or the lock is incomplete. Do not proceed until it is. Report the result.

---

# PART 3 — SURFACE CENSUS

This is the pass that decides how everything else is captured. **Run it before the
component census, and never skip it because the target "is just a form."**

Sniff the shipped bundle, the DOM, and the runtime globals for every class below.
Detection is a match on any of: an import or chunk name, a global, a DOM signature, or a
distinctive attribute.

For every class you detect, load its capture strategy and its trap list into the plan.
For every class you do **not** detect, say so, because a false negative here is how a
whole surface gets captured with the wrong method.

| # | Class | Probe for | Truth lives in | Capture strategy | Signature traps | Ceiling |
|---|---|---|---|---|---|---|
| 1 | **Node graph / flow** | `react-flow`, `reactflow`, `rete`, `litegraph`, `jointjs`, `gojs`, `cytoscape`, `elkjs`, `dagre`, `d3-force`, `drawflow`, `mermaid`; DOM: `.react-flow__node`, `[data-nodeid]`, `<g class="edge">` | the `nodes` and `edges` arrays in the store | **store only.** Dump nodes and edges with ids, types, positions, port/handle ids, and edge source/target/handle. Normalise the viewport transform out of every coordinate before comparing. | edge routing algorithm; handle and port ids; auto-layout non-determinism; pan/zoom transform contaminating positions; edge selection semantics differing from node selection; connection validation rules | pin the identical layout library and version, or edge geometry will never match |
| 2 | **Free canvas / spatial** | `konva`, `fabric`, `paper`, `pixi`, `tldraw`, `excalidraw`, `two.js`, bare `<canvas>` with pointer handlers | the store if one exists | store first, pixels only to confirm | hit area is not visual bounds; z-order; **order dependence** (same state reached two ways renders different controls); caret versus selection | **no readable store means accuracy falls off a cliff.** Say so, do not work around it. |
| 3 | **Rich text editor** | `prosemirror`, `tiptap`, `lexical`, `slate`, `quill`, `ckeditor`, `tinymce`; DOM: `[contenteditable]`, `.ProseMirror` | the editor schema plus the serialised doc | serialise the doc, normalise, diff | selection model; undo granularity; paste normalisation; input rules and markdown shortcuts; injected state passing tests real keyboards fail | none, if the schema is readable |
| 4 | **Code editor** | `monaco`, `codemirror`, `ace` | the model plus decorations | read the model, not the DOM | virtualised lines; the tokenizer; its own keymap swallowing app shortcuts; a hidden textarea holding real focus | grammar and theme must be the same package |
| 5 | **Data grid / table** | `ag-grid`, `handsontable`, `tanstack-table`, `slickgrid`, `react-data-grid`, `glide-data-grid`; DOM: `role="grid"`, `[aria-rowindex]` | the row model plus column defs | read column defs from source; **scroll programmatically to inventory rows** | virtualisation means the DOM holds only visible rows; sort stability; cell editors are their own surface; frozen columns and header groups; row selection versus cell selection | none |
| 6 | **Spreadsheet engine** | `hyperformula`, `formulajs`, `fast-formula-parser` | the cell store plus its dependency graph | capture formulas as strings and values separately | recalculation order; circular references; error value propagation; volatile functions under a frozen clock | function coverage of the engine you pick |
| 7 | **Charts** | `highcharts`, `chart.js`, `recharts`, `echarts`, `d3`, `plotly`, `visx`, `apexcharts`, `nivo` | the series config plus the data payload | capture the config object and the data, not the drawing | SVG versus canvas renderer changes the whole capture method; tooltips and legends are separate surfaces; animation on data change; the axis tick algorithm | pin the same library, or tick placement and label collision differ forever |
| 8 | **Maps** | `google.maps`, `mapbox-gl`, `leaflet`, `openlayers`, `deck.gl` | drawn geometry plus the viewport | capture geometry as coordinates, and the viewport as centre plus zoom plus bearing | tile provider; projection; drawing and measuring tools are their own surface; geocoding is a third-party call; marker clustering | tiles are theirs. Declare it. |
| 9 | **Realtime / collaborative** | `WebSocket`, `socket.io`, `pusher`, `ably`, `yjs`, `automerge`, `liveblocks`, `phoenix` | the message type set | **two clients, one document.** Enumerate every message type from the bundle. | optimistic UI showing a state the server never had; presence is time-driven and fights the frozen clock; CRDT convergence; reconnect and backfill | any realtime at all pushes the band up one |
| 10 | **Drag and drop** | `dnd-kit`, `react-beautiful-dnd`, `sortablejs`, `react-dnd`, `interact.js`; DOM: `draggable="true"`, `[data-rbd-*]` | the position field in payloads | read the position field across three consecutive reorders and infer the scheme | **ordering strategy** (integer position versus fractional index versus LexoRank); the target that highlights is not always the one that receives; drop-target rects differ from the highlight | none |
| 11 | **Virtualised list** | `react-window`, `react-virtuoso`, `tanstack-virtual`; DOM: a tall spacer plus a small window of children | the item source | scroll programmatically to inventory; never trust a one-shot DOM read | inventory silently truncated at the viewport; scroll restoration; variable item heights | none |
| 12 | **Calendar / scheduler** | `fullcalendar`, `react-big-calendar`, `tui-calendar`, `luxon`/`rrule` in scope | time intervals plus a recurrence rule | capture intervals in UTC plus the display timezone separately | timezones; recurrence expansion (RRULE); DST transitions; all-day versus timed; overlap layout | frozen clock must be chosen deliberately, not inherited |
| 13 | **Media player** | `video.js`, `hls.js`, `plyr`, `wavesurfer`, bare `<video>`/`<audio>` | playback state plus buffered ranges | capture control state, not frames | playback position; buffered ranges; custom controls versus native; poster frame | their CDN and codecs. Stub or declare. |
| 14 | **3D** | `three`, `babylonjs`, `@react-three/fiber` | the scene graph | **compare the scene graph, never pixels** | camera state; lighting non-determinism; asset loading order | pixels are not comparable. Say so up front. |
| 15 | **PDF** | `pdf.js`, `pdfjs-dist`, `react-pdf`, `pspdfkit` | annotations and form fields | treat the canvas page and the DOM annotation layer as **two different surfaces** | coordinate systems (PDF points versus CSS pixels versus device pixels); text layer alignment; signature flows are irreversible | page render is canvas, so the canvas ceiling applies to page content only |
| 16 | **Dynamic forms** | `react-hook-form`, `formik`, `zod`, `yup`, `json-schema-form` | the schema | extract the schema, then fuzz it | validation order decides which error the user sees; cross-field rules; async validation; dirty and touched state | server-side rules need Part 6 Pass B |
| 17 | **Third-party iframe embeds** | `youtube`, `vimeo`, `stripe`, `intercom`, `zendesk`, `hubspot`, `pendo`, `zoho`, `drift` | not yours | **block or stub. Decide now, in writing.** | they inject DOM and will appear as diffs on every capture forever | never matches. Record each one as an accepted ceiling. |
| 18 | **Auth, roles, metering** | role enums, guard components, credit or quota counters, paywall copy | the role matrix and the counter | one session per role; capture the counter as DB-backed, never as a literal | the role matrix multiplies **everything above**; metered features are irreversible actions in disguise | roles you have no account for are unreachable. List them. |

**Write `never_to_be_pushed/discovery/surface-census.md`:**

```
| Class | Detected | Instances (where) | Capture strategy chosen | Traps loaded | Ceiling declared |
```

Then print the census summary to me, and **name the highest-risk class you found and
why.** If you detected class 2 with no store, class 9, or class 14, say it in the first
sentence, because each one changes what is achievable.

---

# PART 4 — COMPONENT CENSUS, RECURSIVE

Now enumerate what is inside the scope.

**Perimeter first.** Get the route table from the framework, not by clicking:
a route manifest on `window`, `app-build-manifest.json`, `__NEXT_DATA__`,
`/rails/info/routes`, or the router config object literal in the bundle. Plus
`sitemap.xml`, `robots.txt`, GraphQL introspection, a served OpenAPI doc.
→ `never_to_be_pushed/discovery/routes.md`

**Vocabulary next.** Pull every script with `Debugger.getScriptSource`. Look for source
maps; if `sourcesContent` is present you get the original TypeScript and this pass drops
from hours to minutes. Extract to `never_to_be_pushed/discovery/inventory/`:

| File | Why it matters |
|---|---|
| `strings.json` | **the primary completeness oracle.** Every user-visible string names a state you must be able to reach. An unreached string is a missed flow, named. |
| `actions.json` | the transition alphabet |
| `endpoints.json` | the API surface before you fire anything |
| `enums.json` | fills every dropdown and filter without guessing |
| `keyboard.json` | interactions with no element attached |
| `flags.json` | states no click can reach |
| `validation.json` | the client half of the rule matrix |

**Turn coverage on:**
```
Profiler.startPreciseCoverage  { detailed: true, callCount: true }
CSS.startRuleUsageTracking()
```
Unexecuted functions and unused CSS rules are unexplored flows, enumerated for you.
This is what lets exploration terminate instead of running until someone gets bored, and
it is why you should not be asking me what to explore next.

**Then build the interaction queue.** Union of four sources, because each misses what
the others catch:

1. `Accessibility.getFullAXTree` for anything with an interactive role
2. `DOMDebugger.getEventListeners` per node, for the divs with handlers that declare no
   role. **This is the one that gets skipped.**
3. `keyboard.json`, for interactions with no element
4. `routes.md`, for entry points nothing on the current page links to

→ `never_to_be_pushed/discovery/queue.jsonl`: stable id, selector, label, type, owning surface class from
Part 3, required precondition, estimated cost.

**Recursion rule.** A component is not censused until every interactive descendant is in
the queue. Opening a menu, a modal, a popover, a drawer or a new route **adds to the
queue**. Keep going until the queue stops growing. A component with children you did not
enumerate is marked `capped`, never `settled`.

**Split off `never_to_be_pushed/discovery/irreversible.jsonl`** from Input Block field 7 plus anything you
discover that deletes, pays, sends, publishes or spends a credit. **Nothing in that lane
is fired during the sweep.**

**Shared-shell rule.** Anything that appears on more than one route (top nav, sidebar,
command palette, toast host, modal host) is its **own slice, built as a layout, once**.
Building it inside the first page means rebuilding it on every page after.

**Two-render rule.** Many routes render completely differently depending on whether data
exists. The empty state and the populated state are **two captures of one route**. If you
can only reach one, extract the other from the bundle and mark it unconfirmed. If you can reach
the empty state only, seed the populated state per Part 5A so it is captured and
verified, not merely extracted from the bundle.

## Gate 1, ~30 seconds of my time

Re-run Preflight Checks 1 and 3 first and print both lines. Then print the census and
stop:

```
PREFLIGHT           chrome MCP ✓|✗   CDP ✓|✗
SURFACE CENSUS      <n> classes detected, highest risk: <class> because <why>
ROUTES              <n> total, <n> in scope
INTERACTIONS         <n> queued, <n> irreversible (quarantined)
ENTITIES (est)       <n>
MUTATIONS            <n>, of which <n> irreversible
ROLES                <n> available to me, <n> unreachable
STRINGS              <n> total  ← the completeness target
BAND                 S | M | L | XL, from the corpus cost model
SLICE PLAN           1. <shared shell>
                     2. <smallest slice containing one write>
                     3. ...
CEILINGS             <declared, per Part 3>
CORPUS DELTA         traps that fired that the corpus did not predict: <n>
```

Wrong here means everything downstream is wasted. Right here means I can leave.

**If SCOPE is APP, stop here and wait for my approval.** If SCOPE is COMPONENT, continue.

---

# PART 5 — THE PER-INTERACTION LOOP

One interaction in, one verified vertical slice out. Per item in `queue.jsonl`.

**Schema cannot be step 1.** Until an interaction fires there is no payload to induce a
schema from. Schema is step 4.

### 1. Precondition (scope)
Read the store and assert you are in the state this interaction requires. If not, replay
the shortest recorded path; do not click around. Verify from the **store**, never the DOM
alone, and require stability across two polls: during a transition the DOM shows the
outgoing state and the first matching node is usually the one leaving. If the precondition needs
data that does not exist, seed it per Part 5A, then re-verify from the store.

### 2. Snapshot before, four channels
```
DOMSnapshot.captureSnapshot   { computedStyles: COMPUTED_STYLE_MANIFEST }
Accessibility.getFullAXTree
store dump                     via the Part 3 adapter
Network                        clear the recorder
```

**`COMPUTED_STYLE_MANIFEST`** (pass all of it; every omission becomes a diff later):

```
box:      width height minWidth minHeight maxWidth maxHeight boxSizing
          padding{Top,Right,Bottom,Left} margin{Top,Right,Bottom,Left}
          border{Top,Right,Bottom,Left}{Width,Style,Color}
          border{TopLeft,TopRight,BottomRight,BottomLeft}Radius
layout:   display position top right bottom left zIndex float clear
          flexDirection flexWrap flexGrow flexShrink flexBasis order
          justifyContent alignItems alignSelf alignContent gap rowGap columnGap
          gridTemplateColumns gridTemplateRows gridAutoFlow gridColumn gridRow
          overflow overflowX overflowY overflowWrap isolation
type:     fontFamily fontSize fontWeight fontStyle fontStretch lineHeight
          letterSpacing wordSpacing textTransform textAlign textIndent
          textDecoration{Line,Color,Thickness} textUnderlineOffset
          whiteSpace wordBreak hyphens fontVariantNumeric fontFeatureSettings
          textOverflow webkitLineClamp verticalAlign
paint:    color backgroundColor backgroundImage backgroundSize backgroundPosition
          backgroundRepeat backgroundClip backgroundOrigin backgroundBlendMode
          opacity boxShadow textShadow filter backdropFilter mixBlendMode
          outline{Width,Style,Color} outlineOffset
svg:      fill fillOpacity stroke strokeWidth strokeLinecap strokeDasharray
motion:   cursor pointerEvents userSelect touchAction resize appearance
          transition{Property,Duration,TimingFunction,Delay}
          transform transformOrigin willChange visibility accentColor caretColor
          scrollBehavior scrollbarWidth scrollbarColor aspectRatio
```

Also capture, per element, the things a screenshot cannot give you:

- **Tokens once per page:** `getComputedStyle(document.documentElement)` filtered to
  `--*`, plus `body` and each themed subtree root. → `never_to_be_pushed/discovery/design-tokens.json`
- **Geometry:** `DOM.getBoxModel`, all four quads. **Hit area is not visual bounds.**
- **Pseudo-elements:** `::before ::after ::placeholder ::selection ::marker ::first-line
  ::-webkit-scrollbar{,-thumb,-track}`, plus `CSS.getMatchedStylesForNode` for the rules
  behind them. Checkbox ticks, badge dots, separators, focus rings and placeholder colour
  all live here.
- **States:** `CSS.forcePseudoState` for `:hover :focus :focus-visible :active :disabled
  :checked :indeterminate :invalid :required :placeholder-shown :open`. Forced state for
  **styles**; real input for **behaviour**. Both, never one.
- **Fonts:** `CSS.getPlatformFontsForNode`. Catches silent fallback, the largest source
  of spurious pixel diffs.
- **Assets:** real stylesheets, the SVG sprite and every `<use href>` id, images and font
  binaries via `Page.getResourceContent`. **Take them. Never redraw an icon.**
- **Breakpoints:** `CSS.getMediaQueries`, then recapture at their widths, not yours.
- **Copy, verbatim:** curly versus straight quotes, real ellipsis, non-breaking spaces,
  British versus American spelling, sentence versus title case.
- **Portals and scroll:** where overlays mount (body portal versus in-tree), which
  ancestors create stacking contexts, which element actually scrolls, and whether the
  body locks behind an overlay.

### 3. Fire it for real
`Input.dispatchMouseEvent` at the centre of the **hit area** from `DOM.getBoxModel`, or
`Input.dispatchKeyEvent` for a shortcut. Never a synthetic `.click()`, never JS-injected
state. Injected state passes tests the real app fails.

### 4. Capture the effect, induce the schema (schema)
Diff all four channels plus coverage.

| Channel | Harvest |
|---|---|
| Network | request payload and response body via `Network.getResponseBody`. One JSON Schema per endpoint. |
| **Store delta** | the most informative channel. How the client keys and indexes new data gives you the real primary keys, relations, id format and ordering field. |
| DOM and AX delta | what appeared, what changed role, name or state |
| Coverage delta | which functions and CSS rules executed for the first time |

→ one row in `never_to_be_pushed/discovery/input-effect.md`: trigger, handler, actions dispatched, state
delta, network calls, visual result. That table is the action space, built as a side
effect of the sweep.

### 5. Derive the contract
Endpoint and method. Request and response schemas. Status codes and error shapes (404
missing, 409 conflict, 422 invalid). **id format** (integer, uuid, nanoid, prefixed).
**ordering strategy** (integer position, fractional index, LexoRank). Timestamp format
and timezone. Pagination shape. Invariants preserved.

Match id format and ordering strategy exactly. Top source of divergence, and a wrong id
format leaks a learnable pattern to an agent. → `never_to_be_pushed/discovery/api-contract.md`

### 6. Backend and migration (backend)
Implement that one endpoint per `AGENTS.md`: schemas before logic, thin router, service
layer, full OpenAPI metadata because the grader parses it, mutation in one transaction.

If the interaction writes, create its migration now and seed from the **real captured
payload**, never invented data. One migration per module, committed, never edited after,
history a single linear chain. An edited migration destroys reproducibility of old
episodes.

**Ship the environment-only endpoints with the first migration, not later:**
`POST /reset`, snapshot and restore, and a state introspection endpoint so rewards read
rows instead of scraping the DOM.

**If the reference's rendering model makes 1:1 network mirroring impossible** (for
example server components on their side, SWR on yours), stop and say so, propose the
minimal deviation, and record it in `docs/DOMAIN_NOTES.md`. Do not silently invent an
endpoint shape.

### 7. Persistence check (persist)
Three assertions, in order, all before touching UI:
1. Write, reload the page. The value survives.
2. Write, restart the backend. It still survives, so it is in the database, not memory.
3. `POST /reset` returns state exactly to seed, and a snapshot taken before the write
   restores byte-identically. Run reset twice to prove idempotence.

Then regenerate any generated state-contract artifact. Never hand-edit generated JSON.

### 8. Build the UI and converge (ui)
Geometry-diff against step 2's computed styles. **Never a percentage.** "6% of pixels
differ" is unactionable and no agent can fix it. Emit instructions:

```
>body[0]>main[1]>div[0]>@submit — "Save"
- backgroundColor: expected rgb(79,70,229), got rgb(67,56,202)
- fontWeight:      expected 600, got 500
- paddingTop:      expected 10px, got 12px
- cursor:          expected not-allowed, got pointer
```

Expect three to five rounds. You do not generate parity, you converge to it. Diff the
a11y tree in the same pass: a correct-looking button that is a div with an onClick is a
failure.

### 9. Verify four channels, then requeue
Replay the identical ordered input sequence against reference and clone. Diff pixels, DOM
and AX tree, network calls emitted, and store state. Commit the trace to `e2e/` as a
golden test: input sequence plus expected observations at every step.

Then push every newly revealed interaction onto the queue and mark this one **settled**
or **capped**.

### Routing when verify fails
| Failure | Region | Route to |
|---|---|---|
| Four-channel diff fails | settled | **rebuild.** Spec complete, implementation wrong. |
| Four-channel diff fails | capped | **re-explore that region.** Spec incomplete, so rebuilding is guessing. |
| Target unreachable through the UI | either | **route as a feature defect,** not a failed attempt. That distinction is the difference between an eval harness and a bug tracker. |

## Gate 2, ~20 minutes of my time
Re-run Preflight Checks 1 and 3 and print both lines. Then, when the queue drains, print
the spec summary and stop. This is my actual job in the whole pipeline: reading the spec.
Everything before and after it is watching a board.

---

# PART 5A — SEEDING: WHEN, FROM WHAT, AND HOW IT STAYS DETERMINISTIC

Seeding is not a setup chore done once. It is a step that fires whenever a state you
need does not exist yet. The repo's AGENTS.md "Seed realistically" rules apply in full
and win on any conflict; this part says when to seed, where the data comes from, and
the contract every seed must satisfy.

## When seeding is required (any one of these triggers it)

| Trigger | Where in the loop |
|---|---|
| A precondition needs data that is not there: an item to edit or delete, a populated list, a thread with N messages, a second account, a filled form | Part 5 step 1. Seed, then re-verify the precondition from the store. |
| The two-render rule: the populated state of a route your account shows empty | Part 4. Seed the populated state so it can be captured and verified, not just extracted from the bundle. |
| A grader task needs a defined starting state | Part 8 task authoring. One scenario seed per task. |
| Volume or perf proof needs realistic scale | Part 5 step 7 and AGENTS.md Tier 3 perf. |
| An error, empty, or edge state that only appears at a boundary: zero items, one item, max items, an overdue date, a name at max length | Part 6 Pass B. |

If you reach a step and the data is not there, you seed it. You do not skip the step,
you do not fake the render, and you do not hardcode the value.

## Where seed data comes from, in priority order

1. **Real captured payloads from the reference.** Response bodies you recorded in
   Part 5 step 4. Highest fidelity: shapes, id formats, enum values, and field
   relationships are exactly right. Strip nothing, rename nothing.
2. **Derived from the reference's own observable data.** Counts and ratios you can see
   in the live app (a sample dashboard, a public listing, a demo account). Match their
   ratios, not their totals, per AGENTS.md.
3. **Synthesised to the AGENTS.md realism rules.** Only when 1 and 2 cannot supply it.
   Valid FKs, no orphans, created_at ≤ updated_at, start ≤ end, enums inside their set,
   no placeholder junk, no single-owner or single-date uniformity, and names, dates and
   amounts that a real user could plausibly have.

Never a fixture module imported on a production path. Never a canned payload as a
fallback when a query returns empty. Never `test`, `foo`, `lorem`, `User 1..N`.

## Two kinds of seed, kept strictly separate

**Baseline seed.** The environment's reset state. What `POST /reset` returns to. One
per repo, deterministic, committed, wired to the repo's existing `pnpm seed`. It
contains enough volume for the app to look real and for every route's populated state
to render. It is not tuned to any single task.

**Scenario seeds.** Named, per-task or per-test starting states applied on top of the
baseline. `scenario:inbox-three-unread-from-vendor`, `scenario:board-with-nested-todos`.
Each is idempotent, declares what it creates, and is fully undone by `POST /reset`.
RL tasks reference a scenario by name; the grader applies it before the episode. These
live with the tasks and grader and are committed.

A change that alters the baseline is its own change, reviewed on its own, because it
shifts the reset state for every existing task.

## The determinism contract (STRICTLY ENFORCED)

Every seed, baseline or scenario, must satisfy all of these or snapshot and restore are
meaningless:

- **Seeded RNG.** All randomness from one seeded generator. Never `Math.random`, never
  `uuid4()` unseeded, never `datetime.now()`.
- **Frozen clock.** All timestamps derived from the environment's injectable clock,
  which is frozen per episode. Relative dates ("3 days ago") resolve against it.
- **Stable ids.** Ids are either from the captured payload or generated from the seeded
  RNG in the reference's exact id format from Part 5 step 5.
- **Byte-identical twice.** Run `pnpm reset && pnpm seed` twice and diff a dump of the
  DB. Identical, or the seed is broken. Print the result.
- **Through the write path where it exists.** Seed through the service layer so
  invariants hold and the seed exercises real code. Direct inserts are allowed only for
  bulk volume, and they must still pass the same validators.

After adding or changing any seed: reset twice and confirm idempotence, take a
snapshot, restore it, confirm byte-identical, then regenerate the state contract
(`cd backend && uv run python scripts/sync_state_and_triggers.py`). Never hand-edit
`state_schema.json`.

## Seeding the REFERENCE app to capture a state you cannot otherwise reach

Sometimes the state you need exists only if you create data in the reference itself: a
board needs a note before the note rail can be captured. Rules:

- Allowed only through actions that are **not** in `irreversible.jsonl`. Never on a
  paid, metered, sending, or deleting path.
- Prefer the reference's own free or sample surface if one exists.
- **Record everything you dirtied** in `never_to_be_pushed/discovery/DIRTIED.md`: what,
  where, when, and whether you cleaned it up. The human decides what to remove on the
  real account. A recon or build that dirtied the reference and did not say so is a
  defect.

## Placement

Seed scripts and scenario definitions are application code: `backend/` and the tasks or
grader directory, committed. The ledger of what you dirtied on the reference is a
discovery artifact: `never_to_be_pushed/discovery/DIRTIED.md`, never committed.

---

# PART 6 — CLOSING PASSES

### Pass A. Order dependence
The loop gives **state** coverage, not **sequence** coverage, and sequence is where the
deep bugs live: the same nominal state reached two ways can render different controls.

Model settled interactions as a state machine, generate **all transitions**, then **all
ordered pairs**, and diff four channels at each. Do not monkey-test.
→ `never_to_be_pushed/discovery/flow-diagram.md` plus one rule per order-dependent behaviour, each tied to
the measurements that proved it.

### Pass B. Mine the server rules
Client observation alone caps behavioural equivalence around 60 to 70 percent. For a UI
clone that is fair. For an RL environment it is the wrong thing to concede, because
validation and permissions are exactly what an agent gets graded on. **Every rejection
names a rule.**

1. Fuzz each write endpoint: boundary values, wrong types, missing required fields,
   over-long strings, out-of-range numbers, malformed enums, cross-field contradictions.
2. Harvest the errors and induce the rule.
3. Repeat per role for the permission matrix.
4. `Fetch.failRequest` and `Fetch.fulfillRequest` for the error, empty, loading and
   offline states no click reaches. A boundary state that needs data rather than a
   stubbed response — zero items, one item, max items, a value at its limit — is seeded
   per Part 5A instead of stubbed.

→ `never_to_be_pushed/discovery/server-rules.md`, one rule per row with a confidence marker, so the ceiling
becomes a measured number rather than a disclaimer.

### Pass C. The irreversible lane
Governed by Input Block field 7. If the policy is NEVER FIRE, build against fixtures and
stop. If FIRE ONCE:

Fire each item **exactly once, last**, only after the harness is clean, with everything
recording: request payload, response, redirect, store before and after, and any counter
that decrements. **Ask me before the first one, every time, regardless of the policy
field.** That trace is the only ground truth that path will ever produce on this account.

---

# PART 7 — TERMINATION

Discovery is done when **all four** are true. Not three.

- `queue.jsonl` empty and nothing marked capped.
- Coverage plateaued **and** `strings.json` fully reached. Two independent oracles
  agreeing.
- Every ordered pair of transitions either agrees or is a documented rule.
- Every golden trace in `e2e/` clean on all four channels.

Until then, name which condition is unmet. Skipping is fine; implying it passed is not.
"Coverage plateaued, 14 strings unreached" is a complete report.

---

# PART 8 — WRITE THE CORPUS (the build is not finished without this)

Before you report done:

1. Append a record to `../rl_components/rl-corpus/records/<target>.md` from
   `../rl_components/rl-corpus/records/_TEMPLATE.md`. Fill **all seven sections.**
2. Add every new trap to `../rl_components/rl-corpus/archetypes/<archetype>.md`, **each with the
   measurement that proved it.** A trap without evidence is folklore.
3. Add the estimate-versus-actual row to `../rl_components/rl-corpus/CALIBRATION.md`.
4. Add the target's row to `../rl_components/rl-corpus/INDEX.md`.
5. Any new surface class you found that Part 3 does not list: propose it as a row, with
   its probe, truth location, capture strategy, traps and ceiling.

**Section 5 of the record, "What the method got wrong," is mandatory and must not be
empty.** Without it the corpus only accumulates confidence, never correction. Name every
instruction in this prompt that produced a false or misleading result, everything the
inventories missed that only clicking found, and every stage that was the wrong length.

Then list promotion candidates: a trap seen three or more times, a cost estimate off by
40 percent twice in one archetype, or a wrong instruction. Those graduate into the method
only with my approval.

---

# PART 9 — RULES AND ANTI-PATTERNS

**Precedence, highest first:** the repo's `AGENTS.md` → my Input Block → this prompt →
the corpus → your judgment.

| Never | Because |
|---|---|
| Ask me for a screenshot when CDP can read the DOM | it is a lossy render of the weakest channel, and a model reading it guesses colours |
| Re-author CSS, icons or fonts from an image | the main cause of "almost right" |
| Invent UI from memory of what the app "probably" looks like | ask me for another screenshot instead |
| Use JS-injected state to test behaviour | passes tests the real app fails |
| Screenshot-diff into a percentage | unactionable. Emit instructions. |
| Guess an API shape | work from a capture or a spec, never from a plausible guess |
| Fire anything in `irreversible.jsonl` during the sweep | it is not repeatable |
| Explore in order to *discover* flows | that is what the inventories and coverage are for. Exploration confirms, it does not enumerate. |
| Hardcode domain data to make a screen match | a surface that renders literals is a fidelity failure |
| Mark done while a visible diff remains | "close enough" is failure |
| Commit or push on your own initiative | hand me the exact commands |
| Stage, commit, or include in a commit command anything under `never_to_be_pushed/` | local-only by design. Before handing me any `git add` or `git commit`, run `git status --short` and confirm nothing under `never_to_be_pushed/` is staged. If it is, `git restore --staged never_to_be_pushed/` first and say so. |
| Drive an interactive coding TUI with synthetic keystrokes | most fragile thing in the design. Headless print mode or the Agent SDK. |
| Let build agents talk to each other | multi-agent systems fail on inter-agent chatter. Shared state is the repo plus the contracts commit. |
| Share one git checkout between agents | a merge conflict per file per minute. One worktree each. |
| Build or style anything from a video frame, a trace, or a behaviours file directly | video is discovery input. It enters through the queue and the manifest and is built in the Part 5 loop like every other item, with its behaviours as replay proofs. |
| Start building before Gate 1 has been printed | the gates are the protocol. A build that skipped them has no census, no plan, and no measured baseline. |

**Say what you did not verify.** Skipping a check is expected. Implying it passed is not.

**Ask up front instead of proving after.** If a spec is ambiguous (data shape, empty or
error states, layout, copy), ask before coding. A question costs seconds; discovering the
same thing through a deep verification pass costs minutes.

**Placement rule (STRICTLY ENFORCED).** Every file this prompt creates that is not one
of the four exceptions below is written under `never_to_be_pushed/discovery/`, in the
subfolder the OUTPUT CONTRACT names for it. Never at the repo root, never in `docs/`,
never beside the code it describes. Exceptions, and only these:

1. Application code and tests: `backend/`, `frontend/`, `mcp/`, `grader/`, `e2e/`.
2. Edits to existing tracked docs that AGENTS.md mandates: `docs/DOMAIN_NOTES.md`,
   `docs/domain/*.md`, `docs/domain/KNOWN_GAPS.md`. Edit in place, create nothing new
   there.
3. Corpus writes to `../rl_components/rl-corpus/`, which is committed on purpose in
   its own repo.
4. Generated state-contract artifacts the backend regenerates itself, such as
   `backend/data/state_schema.json`.

If you are about to create a `.md`, `.json`, `.jsonl`, `.png`, or any other artifact and
it is not in that list, it goes under `never_to_be_pushed/discovery/`. When unsure,
that folder wins. A stray file at the repo root is a defect: move it and say so.

---

# PART 10 — PARALLELISM (only if I said to fan out)

- **Per surface or region, not per interaction.** Interactions in one region share
  preconditions and must run in sequence.
- **Two independent resource pools.** Exploring is browser-bound, building is API-bound.
  One shared pool serialises work that has no reason to compete.
- **Race, never barrier.** The first region to finish a stage advances and frees its
  slots. A barrier per stage leaves agents idle behind the slowest region.
- **Longest job first**, cost from Gate 1: interactions, regions, surface classes
  detected, times roles, times seed states, **plus mutations and irreversible
  mutations.** Read-heavy surfaces with one write are cheap no matter how many routes
  they have.
- **Contracts are single-threaded.** All step-5 entries merge into one commit before any
  build agent starts.
- **Budgets suspend, never kill.** A runaway region checkpoints and returns its slots.
- **Resume off the per-region state machine.** A long run dies in the middle and you
  cannot afford to re-burn deep exploration budget.

---

# OUTPUT CONTRACT

At the end, `never_to_be_pushed/discovery/` contains all of this. A missing file is an unfinished phase, not
a stylistic choice.

```
never_to_be_pushed/discovery/
  RECON.md               the recon README, if RECON.prompt.md ran first. Intake source.
  recon-shots/           the screenshots recon took, referenced from RECON.md
  README.md              reference app + version, third-party block list,
                         screenshots-as-truth justification if used, declared ceilings
  ASSUMPTIONS.md         every call made without asking me, per Part 0.6
  NOTES.md               everything the human said mid-run, timestamped, surfaced at each gate
  DIRTIED.md             every write made to the reference app to reach a state, and whether it was cleaned up
  auth.json              storageState. Gitignored.
  surface-census.md      Part 3 output: classes, instances, strategy, traps, ceilings
  routes.md              every route: params, auth, surface, in/out of scope
  inventory/             strings, actions, endpoints, enums, keyboard, flags, validation
  design-tokens.json     their custom properties, reconciled against computed values
  queue.jsonl            every interaction, precondition, cost, surface class
  irreversible.jsonl     the quarantined lane
  input-effect.md         one row per interaction: trigger to effect. The action space.
  api-contract.md         per endpoint: schemas, errors, id format, ordering, pagination
  interactions.md         per screen, per element:
                          `id · label · type · location · notes/network`
                          plus a local-parity verdict per element
  flow-diagram.md         the state machine, including order-dependent rules
  server-rules.md         validation + permission matrix, per-rule confidence
  videos/<V>/            frames, trace.md, states.md, behaviours.md per recording
  captures/ref/<V>/      live-reference style captures for every state a video reached
  captures/               four-channel snapshots per state. Gitignored if large.
  coverage/               baseline and final coverage reports
  SPEC.md                only on the screenshots-as-truth path
e2e/                     golden traces
../rl_components/rl-corpus/   updated per Part 8. The one thing that IS committed, in its own repo.
```

**Report at the end, in this shape:**

```
SCOPE            <what was built>
SURFACE CLASSES  <n> detected; <highest risk> handled by <strategy>
TERMINATION      <which of the 4 conditions are met, which are not>
PARITY           four-channel: pixels <x>, DOM/AX <x>, network <x>, store <x>
CEILINGS         <declared, with measured impact>
ASSUMPTIONS      <n> recorded, <n> worth your attention now
NOT VERIFIED     <explicit list>
CORPUS           record written, <n> new traps, <n> promotion candidates
IRREVERSIBLE     <fired / not fired>, and the trace location if fired
NEXT             <the single highest-value next slice>
```
