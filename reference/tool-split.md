# Tool split: what each browser is for, and where each one breaks

## Claude in Chrome (extension MCP)

Strengths: the human's real profile and session; hydrated UI exactly as a user sees it;
hover, click, read DOM, run JS, read the network log, screenshot, all cheap; no capture
run burned to answer "what does this open".

Use it for: the click tree, dropdown and modal contents, confirming a redirect or an
edition, spot-checking a behaviour on the live site, verifying that a clone flow matches
the reference flow, redact-then-shoot screenshots when a clean context is impossible.

Known limitations, each with the workaround that worked:

| limitation | workaround |
|---|---|
| cannot write files | anything that must land on disk goes through Playwright |
| a single long string truncates around 1 KB; arrays around 100 items | return arrays of short strings, page through them; never a whole DOM |
| refuses `file://` URLs | parse saved HTML with Playwright `page.goto('file://...')` |
| `read_network_requests` clears on cross-domain navigation and its `urlPattern` filter can return nothing | read unfiltered; for pre-redirect requests use Playwright `page.on('request')` |
| redacts values resembling cookies or JWTs, sometimes whole payloads | strip query strings in-page first; capture bodies with Playwright |
| screenshots are viewport-only and not under the determinism lock | stitch viewport by viewport and record seams, or use CDP `Page.captureScreenshot` with `captureBeyondViewport` |
| a resize call can report success while the page still measures the old width | measure `innerWidth` and `devicePixelRatio` in-page after every resize; print them |
| page-to-localhost POST from the page is blocked by the harness | do not build export paths; use Playwright |
| the session's permission guard refuses purchase-shaped clicks (create with credits, subscribe) even after the human approved | never work around it; leave the flow open at that step with an in-page request interceptor armed, record the resumable state, let the human click, read the captured request right after (pricelabs/N4) |
| map libraries: a malformed point argument to a rendered-features query returns every feature, so a grid scan "finds" a hit everywhere | pass the library's point type; sanity-check a probe on a point known to be empty (pricelabs/A3) |

## Playwright + CDP

Strengths: writes to disk; byte-exact bodies via `Network.getResponseBody`;
`DOMSnapshot.captureSnapshot` with the full computed-style manifest;
`Accessibility.getFullAXTree`; `CSS.forcePseudoState` for hover and focus styles;
`CSS.getPlatformFontsForNode`; `CSS.getMediaQueries`; `Debugger.getScriptSource`;
coverage; `Input.dispatchMouseEvent` at box-model centres; full-page screenshots under a
lock; `Emulation.setDeviceMetricsOverride`; one Chrome build for oracle and clone.

Use it for: the T0 snapshot, every capture, the pixel oracle, step 8 style diffs, step 9
verification, pixel diff.

Rules:
- Always `launchPersistentContext('never_to_be_pushed/discovery/pw-profile', ...)`, so
  a VPN extension or a manual login the human performed once persists. Headed when an
  extension is needed; the human is told the window must stay open.
- Verify edition and login state in this context at preflight and before every capture
  batch; a change is a `BLOCKED: environment changed`.
- A fresh persistent profile renders the UI kit's default theme when the app stores its
  theme in `localStorage`; seed that key in the profile and assert the theme at Gate 0
  (pricelabs/R-B).
- Handler-only elements (a `div` with a click listener) are found with
  `DOMDebugger.getEventListeners` over the candidate nodes, not by role or tag
  (pricelabs/A1).
- `page.screenshot({clip})` clips to the viewport: crop clips from a full-page capture
  instead of re-shooting each module.
- Attaching to a human's window over CDP (`connectOverCDP`): a service worker started in a
  context the client did not create trips an assertion in Playwright (`_onAttachedToTarget`)
  and kills every attached process, and a stray worker target keeps doing it for every new
  connection. Copy the login out over raw CDP (`scripts/lib/export-login.mjs`) and give each
  tool its own browser with that storageState (gap-audit 2026-10-26).
- A SIGTERM makes Playwright close its browser before the process sees the signal: a loop that
  keeps going then fails every remaining item against a dead page. Trap the signal and treat
  "Target page, context or browser has been closed" as end of run, never as a per-item failure
  (gap-audit 2026-10-26).
- Headless Chromium refuses `navigator.clipboard.writeText` unless the context grants
  `clipboard-write`; every "Copy" button otherwise logs a script error that is the tool's, not
  the app's.
- Bot walls: if the reference returns a challenge, let the real browser session pass it
  (headed, persistent profile). Never spoof headers or proxy around it.

## Both tools together

- Preflight loads the target in both and prints edition and login state side by side.
  They must match.
- Discovery in Chrome pushes nodes; capture in Playwright fills them. Every crossing of
  that line is a row in `discovery/tool-fallbacks.md` with the reason.
- The clone is always captured by the same tool and lock as the oracle it is compared
  against.

<!-- merged 2026-11-02 from the rl_espn copy: sections the canonical copy had lost -->

## Learned from builds 2026-09-24 to 2026-09-29 (promoted 2026-09-29)

| task | tool | evidence |
|---|---|---|
| Seeing a hover, open menu or popover as a user sees it | **Claude in Chrome** (hover + screenshot) | four Playwright attempts captured a dropdown closed, because the screenshot moved focus and the menu closed on blur; one Chrome hover + screenshot showed it |
| Finding a control by what it is | Claude in Chrome `find` | resolved the right element where CSS selectors hit a hidden twin |
| Page state containing URLs with query strings, cookies or ids | **Playwright** | Chrome MCP refuses JS output carrying query strings |
| Which request a control fires, its exact query, the response body | **Playwright** (`page.on('request')`, in-page `fetch`) | Chrome MCP's network read missed a fetch after a select change; the Playwright listener caught it |
| Bulk capture (hundreds of pages' server data) | **Playwright** in-page `fetch` or plain HTTP for page JSON (~1 s/page) | full screenshots cost ~30 s/page; keep them for the oracle subset |
| Computed style, geometry, font diff, pixel diff | **Playwright over CDP**, one Chrome build both sides | every convergence number |
| Quick visual sanity of the clone | Claude in Chrome screenshot | fast, real rendering |
| Clicking through a flow a user would | Claude in Chrome; Playwright for the replayable trace | real events in the real profile |
| A VPN or geo exit | the same VPN extension loaded into the Playwright profile, proven by the edition gate | a Chrome-only VPN left Playwright on another edition |
| Tailwind v4 on a legacy-design page | `leading-normal` is 1.5, not CSS `normal` (use `leading-[normal]`); unlayered global element rules outrank utilities (use `!` or `revert`) | stp L-tw-leading-normal, L-global-input |
| A gate that renders the app | run its dev server from a throwaway copy of the frontend (sources copied, dependencies symlinked), never inside the frontend folder | stp L-shared-next-distdir |
| A long CDP session | one page loader that aborts subframes and scripts on oracle renders and closes pages on exit; keep fewer than 20 page targets | stp L-leaked-frames |
| Resetting a DB while a dev backend auto-reloads | wait until the API answers twice 2 s apart before reset; after reset read one seeded row, and reload the backend if it still serves the old file | stp L-reset-race |
| A git host that stops picking up pushes on an open PR | close and reopen that PR (with the human's authorisation), never a replacement PR | fb/76 |
