# How seemly and seemly-video work, end to end

For every team member. `SKILL.md` is the rulebook the agent follows; this file explains what
happens inside, in order, and why each step exists. Commands are run by the agent unless a step
says a person does it.

## The one-paragraph version

Both skills turn a real web app (the **reference**) into a **clone** that matches it in four
channels: pixels, DOM and accessibility tree, network (API paths and payloads) and stored data.
**seemly** does it when the reference can be opened in a browser: it walks every screen, saves
everything, builds from the captures and verifies each element three ways. **seemly-video** does
it when the reference cannot be opened: it turns screen recordings into labelled, masked frames
and hands them to seemly as the evidence. **Sandbox mode** is the bridge: when a live reference
becomes reachable for a limited time, capture everything first, build offline after.

```
               evidence                          build                     proof
 ┌──────────────────────────────┐   ┌─────────────────────────┐   ┌──────────────────────┐
 │ live app ── seemly walk ─────┼──►│ graph → units (plan)     │──►│ struct/style/pixels  │
 │ sandbox ── walk + sessions ──┼──►│ shell → modules → pages  │   │ write round trips    │
 │ videos ── seemly-video ──────┼──►│ backend, DB, seed, API   │   │ frame_diff, api_diff │
 └──────────────────────────────┘   └─────────────────────────┘   └──────────────────────┘
                    ▲                                                        │
                    └─────── corrections → lessons → overlay → promote ◄─────┘
```

## seemly, phase by phase

### 0. Intake: the only question
You send a URL (plus anything: screenshots, notes). The agent spends three minutes on the page,
then prints one `INTAKE` block with every field filled (target, scope, depth, what never to
touch). You reply `go` or correct a line. From then on it runs unattended and talks to you only
for `PREFLIGHT FAILED`, `BLOCKED` (an irreversible or paid action, a missing login, the
environment changed), `SESSION CHECKPOINT` (context full: start a new session with
`seemly resume`) and `DONE`. Anything else you type is saved as a **correction** and applied.

### 1. Preflight: ten minutes that decide the run
Checks it can actually do the work: the target loads, Chrome and Playwright see the same edition,
theme and login state (`qa/edition_gate.mjs`), files land in `never_to_be_pushed/` (git-excluded),
the push guard is installed. A failure names one fix and stops; cheaper here than later.

### 2. Two browsers, each for what it is good at
- **Claude in Chrome**: discovery and judgment. Opens menus, checks a doubt, does drag or typing.
- **Playwright + CDP**: anything saved to disk byte-exact: DOM, every API response, styles,
  fonts, images, screenshots under a determinism lock.
A logged-in app is handled by a person logging in once in a headed window; `lib/export-login.mjs`
copies that session into a file so several tools run at once without anyone sharing a password.

### 3. Phase A, snapshot: everything at one instant
All in-scope pages captured in one run (time T0): hydrated DOM, every XHR body, page globals,
every text node with where it came from, image and font binaries, a full-page pixel oracle with a
box for every region, and hover and focus states. Personal values are scrubbed at capture time.
Then **provenance**: every visible text node must trace to a captured field (0 unresolved). Then
the **seed**: the data model is induced from the payloads and seeded through the backend.

### 4. Phase B, the walk: the app as a graph
`orchestrator/run.mjs` treats the app as a graph: screens, modals, menus and in-page states are
nodes; clicks are edges.
- **explore** pops the next node from a priority queue, replays the cheapest route to it, saves
  `nodes/<id>/` (screenshot, DOM, accessibility tree, every API read with its request body,
  `inventory.json` of what each element did), then fires every element once. What opens becomes a
  new node.
- **Templates**: nodes with the same structure are one template (one component); after two
  members, others fire only what is new. Lists past 30 rows are sampled. This keeps a 10,000-page
  app walkable.
- **Safety, two layers** (`orchestrator/safety.mjs`): by name, logout is never clicked and money,
  messaging and deletion are queued, not clicked; by request, every non-read call is aborted in
  the browser, so a button that writes anyway shows its failure path instead of changing data.
  Each queued write lands in `pending-writes.jsonl` for a person to decide.
- **Resumable**: every step saves the graph; a crash, a stop or a lost login loses nothing.
  Workers run in parallel by area (`--only-prefix`). The walk is done when it prints `CLOSED`.
- **compare** diffs a walk of the reference with a walk of the clone and lists, per screen, what
  the clone lacks, disables or leaves dead.

### 5. Phase C, build: in the graph's order
`plan` turns the closed graph into units in dependency order: environment and seed, then the
**shell once**, then module archetypes (most-shared first), then templates; every further page
is configuration rows, not new components. `next-unit` writes a packet (members, captures,
routes, writes, lessons) that one agent builds. Per unit: anatomy, semantic HTML matching the
accessibility tree, schema and backend, wiring through `/api`, all eight states, computed-style
convergence against the capture, mounted, writes with a round trip, human-eye pass.

### 6. Phase D, verify: three ways, every element
Structure (role, name, text, href), style (computed CSS per property) and pixels (0 differing per
module) against the capture, plus the QA scripts:

| script | catches |
|---|---|
| `qa/struct_audit.mjs` | an invented or missing nav item, heading, tab, column, field label |
| `qa/human_eye.mjs` | stand-in images, clipped text, unnamed or dead controls |
| `qa/write_roundtrip.mjs` | a save that answers 200 but never lands or does not survive a reload |
| `qa/width_sweep.mjs` | layouts that break away from 1440 px |
| `qa/frame_diff.mjs` | video mode: a built state against its frame on text, layout, structure |
| `qa/api_diff.mjs` | the reference's real API calls the clone does not serve, and field differences |

Gates run on every commit (no literals, no personal data, everything mounted, migrations
round-trip). A gate that checked nothing fails.

### 7. Learning: the skill rewrites its own rules
Every correction you type, every verify failure and every near-miss becomes a lesson and then a
check. `distill` turns a build's lessons into overlay rules on your machine
(`never_to_be_pushed/seemly-local/overlay/`, which win over the shipped rules); `promote` moves
chosen rules into the shared skill. Contested decisions can go to a judged panel of three agents
(`reference/panel.md`), only when you ask.

### 8. QA mode
`run qa` or a bug sheet: each row is reproduced on both sides in the same state, fixed at the
source and diffed side by side. A fix proven only through the API is not fixed.

## seemly-video, step by step

Used when the reference cannot be opened and recordings are the only truth.

1. **Setup** (`setup.sh --selftest`): installs ffmpeg, tesseract, uv; proves the pipeline on a
   synthetic video with 10 planted states (including a 0.2 s tooltip).
2. **Intake**: one block per video (rank: real tenant, vendor, trainer), scope, the coverage
   checklist, browser-chrome share, personal values seen. Reply `go`.
3. **Extract** (`extract_frames.sh`): native-fps event frames (nothing transient is missed),
   2 fps samples, scene cuts, audio, speech transcript.
4. **Dedupe and mask** (`dedupe_frames.py`): layered dedupe down to curated frames; browser chrome
   and every value in `pii.json` (exact names, ids, emails, hosts only) blacked out. Only curated
   frames are read after this.
5. **Label** every curated frame: module, screen, state, flow and step, fields seen, which
   checklist ids it proves. Near-identical frames inherit a labelled head's label. Then `rename`,
   `states` (one canonical frame per state) and `pii-check`, which must pass.
6. **Prove nothing was missed**: gaps between flow steps are rescued from raw frames; 10% are
   re-checked; coverage per checklist id is written; gaps become the next recordings to ask for.
7. **Recon from frames**: one spec per screen, every fact tagged `[frame:<id>]`.
8. **Build with seemly**, then **verify** every built state with `frame_diff.mjs`.
Videos, frames, transcripts and `pii.json` are never committed.

## Sandbox mode (time-boxed live access)

`reference/sandbox.md` is the full playbook. Why it is efficient:

| problem in a live enterprise app | what handles it |
|---|---|
| screens load data through POST "reads", which the walker would abort | `explore --read-posts auto` (reads by name, logged to `allowed-posts.jsonl`) and `--allow-post <regex>` |
| sessions time out mid-walk | `explore --relogin-wait <min>`: prints `LOGIN LOST`, waits for a fresh `export-login`, resumes |
| a shared tenant other people use | `explore --pace <ms>` spaces clicks; writes are never fired by the walker |
| writes (approve, submit, sign off) must be seen for real | `capture/record-session.mjs`: a person drives, it saves each step and every call with its request and response body, tied to the click |
| knowing what the clone's API gets wrong | `qa/api_diff.mjs` over the walk and the sessions against the clone's OpenAPI |
| several roles (employee, manager, admin) | one login file and one graph directory per role |

The order: prepare offline, a one-hour pilot to tune settings, an unattended read walk per role
in parallel with people recording write sessions, then leave and build offline from
`graph-diff.md` and `api-diff.md`. Come back only with a batched question list.

## Where things live

| what | where | committed? |
|---|---|---|
| the skill | `~/.claude/skills/seemly/` (`video/` is seemly-video) | owner, after `promote` |
| walks, sessions, login files, frames | `never_to_be_pushed/discovery/` | never |
| what the skill learned on your machine | `never_to_be_pushed/seemly-local/` | never |
| the clone | `frontend/`, `backend/`, `docs/` | yes, on `feat/*` branches |
