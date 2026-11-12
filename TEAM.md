# TEAM.md: using seemly as a team member

## One-time setup (5 minutes)

1. Install the skill once: `git clone https://github.com/PrateekSinghwY/seemly
   ~/.claude/skills/seemly`, then
   `ln -sfn ~/.claude/skills/seemly/video ~/.claude/skills/seemly-video` (adds
   `/seemly-video`), then restart Claude Code. Update with
   `git -C ~/.claude/skills/seemly pull` (and restart) whenever the owner announces
   an update. Never push to the skill repo; send corrections to the owner, who
   promotes them.
2. Chrome with the Claude in Chrome extension, connected to Claude Code (`/chrome` in a
   session shows "Now using browser ...").
3. Node 20+ and Python 3.11+ on your machine (the repo's `AGENTS.md` lists the stack).
   Playwright installs itself on first preflight if missing.
4. If the target geo-routes, a VPN that both Chrome and a Playwright window can use
   (system-wide, or a Chrome extension you also enable in the Playwright window it opens).
5. Read `~/.claude/skills/seemly/INTAKE.md` once. It is one page.

## Building from videos

1. Once per project: `bash ~/.claude/skills/seemly-video/scripts/setup.sh --selftest`
   (installs ffmpeg, tesseract and uv with Homebrew if missing, gitignores the video
   tree, checks Playwright, runs the planted-event proof). It must print `setup OK`.
2. `/seemly-video <folder with the recordings>`. Correct the `VIDEO INTAKE` block or
   reply `go`. Then it runs to `DONE`: frames, labels, gaps, recon, build, verify.
3. Never commit videos, frames, transcripts or `pii.json`. `pii-check` must pass first.

## Running a build

1. Open Claude Code in the repo. Send the intake. Two lines are required:
   ```
   seemly
   TARGET: https://app.example.com/
   SCOPE:  APP
   ```
   Add `LOGIN`, `NEVER`, `DEPTH`, `EDITION`, `BUDGET` only when the defaults in
   `reference/decisions.md` are wrong for this target.
2. Read the `PREFLIGHT` block once. All ✓: walk away. A ✗ names the single fix.
3. If a browser window opens with `WINDOW OPEN, waiting`, log in or enable the VPN in
   it, then type `done`. Never paste credentials into the chat.
4. You will hear from it only for: `BLOCKED` (do the one thing it names, reply
   `resume`), `SESSION CHECKPOINT` (open a fresh session, send `seemly resume`),
   `DONE` (scorecard and report). `STATUS` at any time returns six lines.
5. Anything else you type mid-run is treated as a correction: saved, applied from the
   next step, and used to improve the skill. You do not need any prefix.
6. Look at `http://localhost:3000` any time. The first page appears within about two
   hours of preflight; the body fills in per module after that.

## Where things live

| what | where | pushed? |
|---|---|---|
| the skill (team base) | `~/.claude/skills/seemly/` (repo `PrateekSinghwY/seemly`) | owner only, after `promote` |
| everything it learns on your machine | `never_to_be_pushed/seemly-local/` | never |
| the build's discovery and state | `never_to_be_pushed/discovery/` | never |
| the clone | `frontend/`, `backend/`, `scripts/`, `e2e/`, `docs/` | yes, on `feat/*` |

`never_to_be_pushed/` is in `.git/info/exclude` on your clone; the skill sets that on
first run. Check with `git status`: nothing under it should ever appear.

## Sharing what it learned

Your corrections and the rules distilled from them stay local. To give the team a rule:
type `promote`, pick the overlay rows to share, and push the branch it prepares as a PR.
Corrections themselves are never shared, only the rules.

## Rules of the road

- Never push `main` directly; the skill pushes to `feat/*` and opens no PRs.
- Never let it fire anything that pays, sends, publishes, deletes or changes account
  settings; list such actions under `NEVER` in the intake.
- Never commit anything under `never_to_be_pushed/`.
- If it asks you a question, that is a defect: answer it, and the answer becomes a
  decision row so nobody is asked again.

## Working in a sandbox (time-boxed logged-in reference)

The order is in `reference/sandbox.md`; your part as an owner of a few capabilities:

1. **Before access:** list your checklist ids, which role reaches each, and your write flows
   with their undo. Hand them to the run owner for `PLAN.md`.
2. **Log in yourself.** Start Chrome with `--remote-debugging-port=<port>
   --user-data-dir=<a folder for your role>`, log in by hand, then run `export-login.mjs` (the run
   owner gives you the line). Never paste a password into Claude. If the walker prints
   `LOGIN LOST`, log in again and re-run the same `export-login` line: the walk resumes.
3. **Record your write flows**, one per session:
   `SEEMLY_STORAGE_STATE=<your auth file> node ~/.claude/skills/seemly/scripts/capture/record-session.mjs --role <role> --name <flow> --start <url>`.
   Do the flow in the window, close it, read `flow.md`. Record the undo, then the error paths.
4. **Ask first** before anything destructive or shared (delete, exports, global settings).
5. **After access:** build from the captures (`graph-diff.md`, `api-diff.md`), never from memory.

For how every part of seemly and seemly-video works end to end, read `HOW_IT_WORKS.md`.
