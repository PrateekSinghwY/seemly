# Capture rules

The seed contains only what the capture serialized. A filter written as an allow-pattern
silently defines the whole evidence base, and every component downstream renders
whatever survived. Every rule here exists because a filter once deleted real content
and the absence was read as a fact about the reference.

## Determinism lock (Playwright, before the first capture)

```
Emulation.setDeviceMetricsOverride   1440x900, deviceScaleFactor 2 (or the decisions.md viewport)
Animation.setPlaybackRate            0
Network.emulateNetworkConditions     fixed values
Network.setBlockedURLs               ADS + ANALYTICS ONLY, explicit host list, every block logged
Page.addScriptToEvaluateOnNewDocument freeze Date.now, performance.now, Math.random,
                                     crypto.randomUUID, Intl timezone
inject CSS                           *,*::before,*::after{transition:none!important;
                                     animation:none!important;caret-color:transparent!important}
await                                document.fonts.ready
```

Gate 0: capture the same state twice, diff byte for byte. Not identical means the lock
is incomplete; do not proceed.

## Never block first-party

The block list names ad and analytics hosts explicitly. Anything on the reference's own
domains, its CDN, its auth or identity bootstrap, its data APIs, stays unblocked. Every
blocked request is written with `blockedReason`. If a module renders empty in the
capture, the first check is: did the block list kill the request that feeds it.

## Globals by deny-list

```
Object.getOwnPropertyNames(window)
  .filter(k => !BROWSER_BUILTINS.has(k))
  .filter(k => typeof window[k] === 'object' && window[k] !== null)
```

Serialize each whole (cycle-safe). Never `startsWith('__')` or any other name pattern.
The site's real page-data global is usually named after the site.

## Sources, in order

1. Hydrated DOM at rest (`document.rest.html`) and after the scroll pass
   (`document.scrolled.html`). For server-rendered sites this is the primary source for
   nav, footer, strips and most modules. Provenance kind `html-hydrated`.
2. Every XHR and fetch from navigation start through the interaction pass, body via
   `Network.getResponseBody`, `.meta.json` beside it.
3. Every window global that survived the deny-list.
4. Public API documents as a second witness, never primary.

## The interaction pass, read-only, per page

Scroll in viewport steps until the page stops growing or the configured feed cap; hover
each top-nav item and save the dropdown DOM; open each picker and save it; click each
carousel arrow to both ends; open each module tab; capture 2 above throughout. Nothing
in the irreversible list is clicked. Nothing that navigates away is clicked.

## Text nodes and provenance

Every visible text node, verbatim (curly quotes, nbsp, ellipsis), with module path and
element path and whether it needed an interaction. Every row resolves to `exact`,
`formatted` (raw value plus format), or `ui_copy` (from the bundle, seeded as a table).
`UNRESOLVED` must be 0.

## Images and fonts

Every `<img>`, `<picture>` source, CSS background image, `<svg><use>` sprite, and every
font binary the browser downloaded: saved by sha256 with a manifest row (URL path, size,
kind, entity ref). Never redraw an icon; never substitute a font without a declared
ceiling.

## Pixel oracle, whole page

Full-page PNG per page and per interaction state at the canonical viewport under the
lock, via `Page.captureScreenshot` with `captureBeyondViewport`. Beside each,
`regions.json`: the box of every module root **including header, sub-nav rows, score or
ticker strips, every column, every promo, footer link groups and legal block**, plus mask
classes: `ad`, `video`, `live-timestamp`, `personalised`. Coverage check: every pixel of
the PNG is inside a listed region or a mask, or the oracle list is defective. Clips are
cropped from the full-page PNG, never re-shot. Hover and focus oracles via
`CSS.forcePseudoState` on every interactive element.

When a clean context is impossible (the human insists on a signed-in profile),
redact-then-shoot: inject `visibility:hidden` on every excluded module's root before the
shutter, assert zero leaks in-page, capture. `visibility`, not `display`, so geometry
holds.

## Scrub

Delete (do not blank) personalisation and identity keys at any depth: session, visitor,
device, user, account, swid, guid, geo, zip, postal, lat, lon, ip, dma, region,
personaliz*, favorite, favourite, recommend, utm_*, fbclid, gclid, every cookie header.
**Scan values too**: emails, phone numbers, token-like strings. Log every deletion. Then
grep the whole capture tree for the developer's identity from `git config`, email
patterns, phone patterns, long tokens. A hit stops the capture.

## Exclusion selectors

Any rule that excludes a module (personalised, account-bound) lives in **one file**,
tests class, id, data attributes and heading text with word-level matching and an
explicit keep-list, and is imported by the capture, the normaliser, the oracle and the
pixel diff. A second copy anywhere is a defect: the class has drifted six times in one
build.

## Snapshot discipline

One T0 for all pages, spread printed. Raw output immutable once written. A re-capture is
a new `raw/<T1>/`, never an edit. Later click-tree nodes are `T0+n`, masked for drift in
the pixel oracle and recorded in `pixel-drift.md`. The frozen clock is T0; relative time
strings are stored twice (verbatim and the timestamp) and asserted equal at verify.
