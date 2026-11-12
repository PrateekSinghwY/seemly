# Sandbox mode: a time-boxed, logged-in reference

Read this when the reference becomes reachable for a limited time behind a login (a vendor
sandbox, a training tenant, a trial), usually after a build that ran from documents or video.
Access is the scarce resource, so the rule is: **capture everything while connected, build
offline afterwards.** Nothing here relaxes a rule in `SKILL.md`; it orders the work so no
connected minute goes to building.

## The five phases

| # | phase | connected? | tools | output |
|---|---|---|---|---|
| 0 | Prepare | no | checklist, write list, pipeline dry run on the clone | `discovery/sandbox/PLAN.md` |
| 1 | Pilot | yes, ~1 h | `export-login`, `edition_gate`, a 30-min `explore` on one area | settings that work for this reference |
| 2 | Read walk | yes, unattended | `run.mjs explore` per role and area, in parallel | `nodes/*/` per role: screenshot, DOM, AX tree, every read with its request body |
| 3 | Write sessions | yes, people drive | `capture/record-session.mjs` | `sessions/<role>/<flow>/`: steps, every call with bodies, `flow.md` |
| 4 | Build offline | no | `compare`, `qa/api_diff.mjs`, units, `frame_diff`, QA scripts | gap list, built units, counted verification |

Phases 2 and 3 run side by side: the walker needs no person, the write sessions do.

## 0. Prepare (before access arrives)

- Turn the project's coverage checklist into `PLAN.md`: one row per checklist id with the role
  that reaches it, the entry URL or menu path if known, and whether it is a read (the walker
  gets it) or a write (a person records it).
- The write list, in order, each with its undo: what is created, approved or changed, and how
  it is put back. Destructive or shared-state writes (delete, payroll-like exports, global
  settings) are marked **ask the sandbox owner first**.
- The question list: every behaviour the documents left open ("does approval clear after an
  edit?"). Each becomes one write session or one click in phase 3.
- Dry run the whole pipeline on the clone (walk it, record one session on it, run `api_diff`
  against its own OpenAPI) so phase 1 only tunes settings.

## 1. Pilot (first hour connected)

1. One person per role logs in by hand in a headed Chrome started with
   `--remote-debugging-port=<port> --user-data-dir=<role profile>`. Nobody types a password into
   Claude or a tool.
2. `node scripts/lib/export-login.mjs --cdp http://127.0.0.1:<port> --domain <host> --out
   never_to_be_pushed/discovery/auth-<role>.json` per role. These files hold live sessions: they
   stay under `never_to_be_pushed/` and are deleted when access ends.
3. `edition_gate.mjs`: right product, version, language, logged in.
4. `run.mjs init --dir never_to_be_pushed/discovery/sandbox-<role> --target <home URL>` then
   `explore --max-nodes 15` on one area. Read `errors.jsonl`, `pending-writes.jsonl`, the
   blocked list in a few `inventory.json` files and `allowed-posts.jsonl`:
   - screens blank because reads are POSTs: add `--read-posts auto`, plus `--allow-post <regex>`
     for each remaining read endpoint after reading its row;
   - session drops: measure the idle timeout; use `--relogin-wait 20`;
   - shared tenant or rate limits: `--pace 400`;
   - in-app iframes or a separate host for part of the app: add it with `--prefix`/`--entry`.

## 2. Read walk (unattended)

One graph per role (`--dir never_to_be_pushed/discovery/sandbox-<role>`), each run with its own
`SEEMLY_STORAGE_STATE`. Inside a role, split by area with `--only-prefix` workers when the app has
path areas; an app with one path for everything is walked by one worker per role.

```bash
SEEMLY_STORAGE_STATE=never_to_be_pushed/discovery/auth-manager.json \
node <skill>/scripts/orchestrator/run.mjs explore --dir never_to_be_pushed/discovery/sandbox-manager \
     --read-posts auto --pace 300 --relogin-wait 20 --max-nodes 200
```

Repeat until it prints `CLOSED`. On `LOGIN LOST` the person for that role logs in again in the
headed window and re-runs `export-login` to the same file; the walk resumes by itself. Every
write the walker meets is aborted and queued in `pending-writes.jsonl`: that file is the
checklist for phase 3, not something to fire from the walker.

## 3. Write sessions (people drive, the recorder captures)

```bash
SEEMLY_STORAGE_STATE=never_to_be_pushed/discovery/auth-manager.json \
node <skill>/scripts/capture/record-session.mjs --role manager --name approve-request --start <URL>
```

A headed window opens with that role's login. The person performs the flow; the recorder saves
each step's screenshot, DOM and AX tree, and every API call with its request and response body,
tied to the click that caused it. Typed values and headers are never recorded. Close the window
to finish; read `flow.md` before the next one.

- One flow per session, named for the checklist id or write-list row it covers.
- Do the undo as its own session (`--name approve-request-undo`): the undo is a flow too.
- Record the error paths deliberately: a required field left empty, a refused approval, an
  overdrawn balance. Clones fail graders on these, not on the happy path.
- Answer the question list here: each answer is a session whose `flow.md` is the evidence.
- A screen recording (QuickTime or OBS) of the same session is optional and goes to
  `/seemly-video` only for what screenshots miss: animations, toasts that vanish, drag.
- Log every change in `discovery/DIRTIED.md` with its undo session; the sandbox ends as found.

## 4. Build offline

1. `run.mjs compare --ref <sandbox dirs> --clone <clone walk dirs> --out graph-diff.md`: screens,
   controls and states the clone lacks, disables or leaves dead.
2. `qa/api_diff.mjs --ref never_to_be_pushed/discovery --openapi <clone>/openapi.json
   [--clone-prefix /api] --out api-diff.md`: endpoints the reference calls that the clone does
   not serve, and request and response fields that differ. Set the prefixes so a path both sides
   share lines up (`--clone-prefix` strips the clone's own extra prefix).
3. Merge both lists with `PLAN.md` into one gap list per checklist id; every row cites its
   capture (`[walk:<node>]`, `[session:<role>/<flow>]`).
4. Build in units (`plan`, `next-unit`), from the captures: anatomy from the DOM and AX tree,
   API from the bodies, states from the steps. A capture beats a document and a frame
   (`decisions.md`, "Sandbox source rank").
5. Verify: `write_roundtrip` per write, `struct_audit`, `human_eye`, and the pixel and two-tab
   paths of `SKILL.md` section 6 while access lasts; `frame_diff` against the session
   screenshots once it ends. Report counted results per checklist id.
6. Go back only with a batched list of specific questions, each answered by one session.

## When access ends

Delete every `auth-*.json` and the headed profiles. Captures stay under `never_to_be_pushed/`:
they can hold whatever data the sandbox had, so the personal-data grep and masking rules apply
to anything taken from them into the repo, exactly as for frames.
