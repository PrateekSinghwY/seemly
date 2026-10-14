// The single third-party block list for every tool that drives the reference: capture,
// the pixel oracle, pixel-diff and the template harness. Four inline copies had drifted.
//
// Ads and analytics ONLY. `bamgrid` and `registerdisney` MUST NOT appear here: they
// bootstrap the reference's OneID SDK, which gates every `apis/personalized/*` call,
// including `scoreboard/header`, the score strip's tile data. Blocking them emptied the
// strip, and the pixel baseline then disagreed with the T0 capture (LESSONS #24). A host
// goes on this list only once it is proven to feed nothing first-party.
export const BLOCKED_URLS = [
  '*doubleclick*', '*googlesyndication*', '*google-analytics*', '*cookielaw*', '*onetrust*',
  '*id5-sync*', '*scorecardresearch*', '*nielsen*', '*adsafeprotected*',
  '*rubiconproject*', '*prebid*',
];
