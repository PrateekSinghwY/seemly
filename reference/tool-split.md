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
- `page.screenshot({clip})` clips to the viewport: crop clips from a full-page capture
  instead of re-shooting each module.
- Bot walls: if the reference returns a challenge, let the real browser session pass it
  (headed, persistent profile). Never spoof headers or proxy around it.

## Both tools together

- Preflight loads the target in both and prints edition and login state side by side.
  They must match.
- Discovery in Chrome pushes nodes; capture in Playwright fills them. Every crossing of
  that line is a row in `discovery/tool-fallbacks.md` with the reason.
- The clone is always captured by the same tool and lock as the oracle it is compared
  against.
