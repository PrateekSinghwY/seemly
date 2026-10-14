# RETRO: ESPN build

## 1. What the human had to say that the skill should have known

Each became a row in `reference/decisions.md`, `tool-split.md`, `capture-rules.md` or
`checks.md`.

- Claude in Chrome for discovery, Playwright for capture; both on the same edition.
- Signed-in profile is acceptable with account-bound modules excluded and identity
  redacted; the choice is the human's, the exclusion is the skill's.
- Vendor fonts and images from the capture.
- Nothing is a GAP while it exists in the T0 DOM.
- Push to feat/* unprompted; never PRs.
- Report to files, not to the human; four permitted messages.
- Pixel scope is the whole page, header to footer, every page.
- Build pages in series; later pages are configuration; maximise reuse.
- Batch the module slices; step 8 before anything is called built.
- Deferrals need release triggers.
- Fix gate-weakening findings immediately; pin the rest.

## 2. What the method got wrong

- **Sequencing.** Nine files and roughly 3,000 lines of process were written before one
  component existed. Verification infrastructure consumed most of fourteen hours; the
  first visible page took six. The skill now has a two-hour first-page deadline and
  batches rigor after a page exists.
- **No environment dry run.** Signed-in Chrome, India geo, VPN as a Chrome-only
  extension, bot wall from datacenter IPs: all discoverable in ten minutes, all
  discovered over hours. Preflight now loads the target in both tools and compares.
- **Capture instructions caused the missing data.** "Block third parties" blocked the
  site's own auth bootstrap; "look for `window.__*`" skipped `window.espn`. The scores
  strip was never captured and its absence became a GAP. Capture rules now forbid
  first-party blocking and allow-pattern globals, and every `NOT CAPTURED` needs proof.
- **Report blocks were stops.** Every "print this block" in the prompts ended a Claude
  Code turn. The no-stop contract is now paragraph zero.
- **Rulings were reactive.** Each question was a missing row in a decisions table that
  did not exist. It exists now with 33 rows.
- **Pixel oracle scoped to modules.** "Per module clips" without "whole page" left the
  header and footer without an oracle. The oracle coverage check now audits the PNG.
- **Tool priority flipped three times.** Playwright as truth, Chrome first, Chrome only.
  Each flip cost a session. The split is now fixed by strength in `tool-split.md`.
- **Rigor added when pace was the problem.** Per-slice fresh-eyes reviews, nine gates per
  sweep, ledger rows per defect. They caught real defects (personal images in the seed,
  unmounted components, Tailwind emitting nothing, 46 emails in payload values). The
  skill keeps every one and batches when they run.

## What worked and is kept

100 percent text provenance; zero typed data enforced by an AST gate; the
self-correction ledger (26 rows, several promoted); fresh-eyes review finding what every
gate passed; step 8 convergence taking the shell from 68 property diffs to 4 declared
ceilings; one page component for five routes with league as a parameter; the scrub
catching emails in values; the push guard catching a hook that discarded exit status.
