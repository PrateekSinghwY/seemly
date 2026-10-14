# Principles: what one build taught, stated for any web app

Each line was learned on a specific site and is written here without the site, so it
applies to the next target whatever it is. `distill.md` appends to this file when a
lesson generalises.

## Sequencing

- Verify the environment for ten minutes before designing anything: reachability from
  this machine, edition or geo routing, login state, which tool has the VPN, bot walls.
- Get one page rendering real data within two hours. Rigor after a page exists, not
  instead of it. Gates and reviews are batched around slices, never allowed to consume
  the run.
- Snapshot all in-scope pages at one instant first; explore the click tree while the
  shell builds; build per node; converge per node.
- Pages after the first are configuration. If they are not, the module library is wrong,
  not the page.

## Capture

- The seed contains only what the capture serialized. Every filter is a deny-list and
  logs what it dropped. Never an allow-pattern on hosts, globals or selectors.
- A site's own auth or identity bootstrap is first-party even when served from a
  different domain; blocking it silently empties every personalised or gated request.
- The page-data global is usually named after the site, not `__something`.
- Server-rendered sites put most content in the hydrated DOM; the DOM is a source with
  provenance `html-hydrated`, and the nav, footer and strips are seeded from it.
- Content that appears without a button (infinite scroll, polling, lazy modules) is found
  in the network log during the interaction pass, not by looking for a control.
- An empty module in the capture is a capture question first and a GAP only when an
  allowed request demonstrably returned empty.
- Negative verdicts are evidenced on every in-scope page; one page proves nothing.
- Scrub values as well as keys: identity hides in payload bodies (emails of authors,
  ids in URLs).
- One instant, one T0; later nodes are T0+n and masked for drift.

## Pixels

- Pixel parity needs an oracle frozen at capture time; the live site drifts within
  minutes. Whole page, header to footer, audited against the PNG for coverage.
- Compare per module with masks for what can never match (ads, video, live timestamps,
  personalised modules); never a page-level percentage.
- Both sides in the same Chrome build, viewport, DPR and lock, on the same machine.
- Computed styles are truth; screenshots are the shot list. A shell built from how a
  screenshot looks needed 68 property fixes.
- Fonts: vendor what the reference served; licensed faces produce sub-pixel drift
  forever otherwise. Sample the shell's fonts, not only body and headings.
- A resize the tool reports as done may not have happened; measure in-page.

## Tools

- Discovery in the human's real browser; capture in a persistent scripted profile;
  never let the two see different editions or login states.
- Chrome MCP cannot write files and truncates; do not push a megabyte through it.
- A stale process on the dev port is not your build; start your own on a free port.
- Manual login or VPN once, in a headed persistent profile; never scripted.

## Rules and gates

- A rule copied into two places drifts; one definition, imported everywhere. Six drifts
  in one build came from one exclusion selector.
- Substring matches on ids or headings eat real content; match at word level with a
  keep-list.
- A check that exits 0 having checked nothing is a defect; every check writes `ran` and
  a count.
- A hand-edited git hook may swallow exit codes; hooks come from the tool-managed config.
- A deferral without a release trigger stays blocked forever.
- A component not mounted is not built. A control without a handler that is not
  genuinely disabled does not ship.
- Captured strings leak into odd places: OpenAPI examples, test fixtures, seed manifests.
  The literal gate scans them all.

## Process

- Every progress message to the human is a stop. Report to files; speak at gates,
  blocks, checkpoints and done.
- Every question the agent asks is a missing row in the decisions table. Add the row;
  do not answer the question twice.
- Push to a feature branch unprompted; never main; never PRs.
- A fresh-eyes reviewer with no build context finds what every gate passed; run it per
  batch, never skip it.
- Record predicted versus actual convergence rounds; a rising trend is the method
  failing and outranks the slice.
- The scorecard is the accuracy rate. Numbers are measured, never estimated.
