# RECON.prompt.md

Runs **before** `RL_BUILD.prompt.md`. Explores the target read-only, takes every
screenshot a human would otherwise take, and writes `never_to_be_pushed/discovery/RECON.md`: a first-hand
exploration report whose sections map one-to-one onto the RL_BUILD intake, with the
answers already filled in from evidence.

The point: when RL_BUILD runs next, it reads `RECON.md` as the intake and asks the human
**only the DOUBTS section.** Nothing else needs typing.

This prompt lives in `never_to_be_pushed/`. Invoke it from the repo root by saying
"Read never_to_be_pushed/RECON.prompt.md and follow it" — do not paste it. The only input
is one line:

```
TARGET: <url>            [optional: component name]   [optional: one sentence of context]
```

Everything else is derived. Do not ask for more before starting.

---

## Hard rules for recon

- **Read-only. Nothing is fired that writes.** No form submit, no create, no delete, no
  send, no payment, no credit spend. If a button's copy or handler looks like it writes,
  it goes in the irreversible list and is not clicked. Opening menus, dropdowns,
  popovers, tabs, accordions, filters, and navigating routes is fine.
- **Screenshots are for the human, not for you.** You read the DOM. The screenshots go in
  the README so the human can review the shot list without opening the app.
- **Never ask a question mid-run.** Anything uncertain becomes a line in DOUBTS.
- **Never touch `.gitignore`.** Before writing anything under `never_to_be_pushed/discovery/`, run the
  exclude guard:
  ```bash
  grep -qx 'never_to_be_pushed/' .git/info/exclude 2>/dev/null || echo 'never_to_be_pushed/' >> .git/info/exclude
  ```
- **Time box: 30 minutes.** Recon is a survey, not the build. If it is not done at 30,
  write what you have and mark the gaps.
- **Placement rule (STRICTLY ENFORCED).** Every file this prompt creates that is not one
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

## Step 0 — Preflight: prove both tools are live (STRICTLY ENFORCED)

Recon needs **both** Claude in Chrome and Playwright with a CDP session. Not one. Not
"probably." Run every check below and print the result. **Never print a ✓ for a check you
did not actually execute.** If any required check fails, stop, print the fix, and wait.

**Check 1. Claude in Chrome MCP is connected.**
Look for the `mcp__claude-in-chrome__*` tools in your tool list, then prove it by
calling `tabs_context_mcp`. A tab list back means connected. Tools absent, or the call
errors, means not connected. Also run `claude mcp list` in Bash and confirm the Chrome
server is listed and shows as connected.

**Check 2. Playwright is installed and Chromium is present.**
```bash
node -e "console.log(require('playwright/package.json').version)" \
  || echo "PLAYWRIGHT MISSING: run  npm i -D playwright && npx playwright install chromium"
npx playwright install --dry-run chromium 2>&1 | head -3
```

**Check 3. A CDP session actually opens.**
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

**Check 4. The exclude guard is in place** (from the hard rules above). Confirm
`grep -x 'never_to_be_pushed/' .git/info/exclude` returns a line.

Print exactly:

```
PREFLIGHT
  claude-in-chrome MCP   ✓ connected, <n> tabs         | ✗ ABSENT
  claude mcp list        ✓ chrome server listed         | ✗ not listed
  playwright             ✓ <version>                    | ✗ missing
  chromium               ✓ installed                    | ✗ run npx playwright install chromium
  CDP session            ✓ Browser.getVersion + eval ok | ✗ <error>
  exclude guard          ✓ never_to_be_pushed/ excluded | ✗ not set
```

**Both tools are required for recon.** If Claude in Chrome is ✗: stop and tell the human
to connect the Chrome extension MCP to this Claude Code session and restart. Do not
proceed with Playwright alone unless the human explicitly says so, because without the
logged-in profile you cannot record the click path, take authenticated screenshots, or
export `auth.json`. If Playwright or CDP is ✗: print the install line and stop. Step 3
cannot run without it.

Only when every row is ✓ do you continue to Step 1.

## Step 1 — Homework (2 minutes, silent)

Read `AGENTS.md`, `docs/DOMAIN_NOTES.md`, `docs/domain/KNOWN_GAPS.md`, any existing
`never_to_be_pushed/discovery/`, and `../rl_components/rl-corpus/INDEX.md` plus `CALIBRATION.md`. Inventory
what is already built: routes, OpenAPI endpoints, migrations, components, `e2e/`.

You need this so the README says "already built" where it is true instead of proposing
to rebuild it.

---

## Step 2 — Claude in Chrome pass (10 minutes, logged-in, first-hand)

Use the Claude in Chrome MCP. You are already authenticated in the user's real profile.

1. **Confirm the tab and the target.** Open the URL. Record the final URL after
   redirects, the page title, and whether an auth wall appeared.
2. **Record the click path.** From the app's landing page to the target, every click.
   Write it as an ordered list. This becomes intake field 3.
3. **Open everything that opens, without writing.** Every nav dropdown, every menu, every
   popover, every tab, every accordion, every filter, the avatar or account menu, every
   settings entry point you can see. Note each destination.
4. **Screenshot every screen and every reachable state.** One file per state, named
   `never_to_be_pushed/discovery/recon-shots/<nn>-<screen>-<state>.png`. At minimum: each screen at rest,
   each dropdown open, each modal or drawer open, each empty state you can see, each
   filter applied. Use `save_to_disk`. Do not screenshot the same state twice.
5. **Find the roles.** The avatar menu, a role label, a workspace switcher, an admin
   link, a plan or tier badge, a credits or quota counter. Record what the current
   account is, and any role names you see referenced.
6. **List what you could not reach.** Every state you saw a hint of but could not open:
   a populated list when the account is empty, a paid feature behind a badge, a role you
   are not, a screen behind a paid flow. This becomes the human's shot list, if any.
7. **Export the session.** Save cookies and storage as `never_to_be_pushed/discovery/auth.json` in
   Playwright `storageState` format so Step 3 runs without a login. Never commit it.

If Claude in Chrome is not connected: skip to Step 3 with a note, and add a DOUBT asking
the human to log in once by hand so Playwright can save `auth.json`.

---

## Step 3 — Playwright + CDP pass (15 minutes, structured)

Launch Playwright with `storageState: 'never_to_be_pushed/discovery/auth.json'`, open a CDP session with
`context.newCDPSession(page)`, and load the target.

1. **Framework and rendering model.** Detect Next.js (App or Pages router), Nuxt, Rails,
   Angular, a plain SPA. Then the question that decides the backend architecture: **does
   first paint fire client API calls?** Clear the network log, reload, count XHR and fetch
   calls before any interaction. Zero means server-rendered, and 1:1 network mirroring
   will need a recorded deviation.
2. **Route table.** From the framework's own manifest (a route manifest on `window`,
   `app-build-manifest.json`, `__NEXT_DATA__`, the router config literal in the bundle),
   plus `sitemap.xml` and `robots.txt`. Mark each route in or out of scope for the
   target.
3. **Bundle pull.** `Debugger.getScriptSource` for every first-party script. Note whether
   source maps and `sourcesContent` are present, because that changes the RL_BUILD
   estimate by hours.
4. **Surface census, all 18 classes.** For each class in the RL_BUILD Part 3 table,
   probe the bundle imports, globals and DOM signatures. Record detected or not, with the
   evidence. Name the highest-risk class found.
5. **Third parties.** Every non-first-party script and stylesheet: analytics, session
   replay, in-app guides, chat widgets, ad tags, embeds. These become the block list.
6. **Irreversible candidates.** Grep the bundle's user-visible strings and the live DOM
   for: delete, remove, archive, send, publish, pay, purchase, upgrade, subscribe,
   confirm, credit, quota, and any counter that decrements. List each with where it
   appears. **Do not click any of them.**
7. **Interaction count estimate.** Union of `Accessibility.getFullAXTree` interactive
   roles and `DOMDebugger.getEventListeners` per node on the target screens. A count, not
   a queue. The queue is RL_BUILD's job.
8. **Quick token read.** `getComputedStyle(document.documentElement)` filtered to `--*`.
   Count them and sample five. If zero, note that styling is not token-driven, which
   changes RL_BUILD Stage 5.
9. **Fonts.** `CSS.getPlatformFontsForNode` on the H1 and body. Name the faces actually
   rendered and whether they are likely licensable.

---

## Step 3b — Video evidence, if recordings exist

If the human provides screen recordings of the reference, run the **VIDEO TO TRACE**
procedure on each one. A recording is the cheapest way to learn a *sequence* — which
control leads to which state, in what order, with what intermediate frames — and the
most expensive way to learn a *style*. Treat it accordingly.

1. **Frames, deduped by scene change.** Not every nth frame: a scene-change filter, so
   one frame per visually distinct state instead of hundreds of duplicates.
2. **A timestamped trace.** `trace.md`: one row per event, `mm:ss.mmm · what changed ·
   which control was under the cursor · which state resulted`.
3. **States mapped to KNOWN or NEW.** Against the existing surface census and queue.
   `states.md`. A NEW state is the point of the exercise; a KNOWN one is a free
   confirmation.
4. **OCR every frame, checked against `inventory/strings.json`.** A string the video
   shows that the inventory does not have means the inventory is incomplete, not that
   the OCR is wrong — go and confirm it on the live reference.
5. **Behaviour rules with trace evidence.** `behaviours.md`: one rule per row, each
   citing the timestamps that support it. A rule with no timestamp is a guess.
6. **Replay on the live reference via Claude in Chrome, capturing styles per state.**
   **Mandatory, not optional.** Drive the same sequence on the real app and capture
   computed styles and the AX tree for every state the video reached.

Outputs go under `never_to_be_pushed/discovery/videos/<V>/` and
`never_to_be_pushed/discovery/captures/ref/<V>/`, and merge into `queue.jsonl`,
`input-effect.md`, `inventory/strings.json` and the component manifests. Add a
`## Video evidence` section to `RECON.md` recording, per video: what it covers, trace
row count, which states were NEW, which behaviour rules it produced, and every DOUBT it
raised — a behaviour you could not confirm, or a write you could not classify as free
or metered.

**Frames are the shot list. Styles come from the live reference. Never from a frame.**
A frame is a lossy render at the recording's resolution, colour profile and compression;
a colour read off one is wrong in a way that looks right. The video tells you *where to
point Chrome*, and Chrome tells you what the pixel actually is.

---

## Step 4 — Write `never_to_be_pushed/discovery/RECON.md`

Use exactly this structure. Section numbers 1 to 10 match the RL_BUILD intake fields, so
RL_BUILD can read them directly. Every claim cites its evidence: a screenshot filename, a
bundle path, a network entry, a DOM selector.

```markdown
# RECON — <target name>

_Generated <date> by RECON.prompt.md · read-only · <n> screenshots · <n> minutes_

## Summary (5 lines, for a human in a hurry)
- what this is, in one sentence
- archetype guess and highest-risk surface class
- recommended SCOPE and why
- the one architectural fact that changes the build (rendering model, canvas, realtime)
- number of DOUBTS below, and whether any are HIGH

## 1 TARGET
final URL, title, framework, rendering model (client API calls on first paint: n)

## 2 SCOPE, recommended
APP | COMPONENT, with the reasoning. Route count in scope vs total.

## 3 HOW TO REACH IT
ordered click path from the landing page, with the screenshot at each step

## 4 LOGINS AND ROLES
current account and role · roles referenced in the UI or bundle · auth.json saved yes/no
· roles I could not access

## 5 SCREENSHOTS TAKEN AND STATES NOT REACHED
table: file · screen · state · notes
then: **States I could not reach** (this is the human's shot list, often empty)

## 6 WHAT ALREADY EXISTS
from the repo: routes built, endpoints, migrations, components, KNOWN_GAPS entries
from the live app: things visibly disabled, greyed, or coming-soon

## 7 IRREVERSIBLE OR METERED CANDIDATES
table: label · where · evidence · why I think it writes
recommended policy: NEVER FIRE (default)

## 8 FIDELITY BAR
default MAXIMUM, unless a surface class forces a ceiling (say which)

## 9 CONSTRAINTS FOUND
stack from AGENTS.md · deviations already in DOMAIN_NOTES · CODEOWNERS paths in scope

## 10 DONE MEANS
default: RL_BUILD Part 7 termination

## Surface census preview
| # | Class | Detected | Evidence | Risk |
(all 18 rows, detected or not)

## Route table
| Route | Params | Auth | In scope |

## Third parties to block
list

## Corpus match
closest past builds from rl-corpus · traps already documented for this archetype ·
cost model band and estimate

## DOUBTS — the only section a human must read
Split by severity. Each one is a question with the options laid out and my default.

### HIGH — changes the plan
- [ ] ...   options: A | B   my default: A because ...

### LOW — changes a detail
- [ ] ...   options: A | B   my default: A because ...

If this section is empty, say so: "No doubts. RL_BUILD can run on defaults."
```

---

## Step 5 — Hand off

Print to the console:

```
RECON DONE  <target>  <n> screenshots  <n> routes  <n> irreversible candidates
ARCHETYPE   <name>, highest risk: <class>
SCOPE       <APP|COMPONENT> recommended
DOUBTS      <n> HIGH, <n> LOW   → read never_to_be_pushed/discovery/RECON.md § DOUBTS
NEXT        say "Read never_to_be_pushed/RL_BUILD.prompt.md and follow it".
            It reads RECON.md and asks only the DOUBTS.
```

Then stop. Do not start building. Do not run RL_BUILD yourself.
