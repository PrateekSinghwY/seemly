// The determinism lock (reference/capture-rules.md). Registered ONCE per page, through
// `Page.addScriptToEvaluateOnNewDocument`, so it applies to every document the page
// loads. A style injected with `page.addStyleTag` before the first `goto` is discarded
// with the blank document it was added to, so the capture ran with no lock at all, and
// Gate 0 ("byte-identical twice") could not pass.

export const LOCK_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };

const LOCK_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;'
  + 'animation-duration:0s!important;transition-duration:0s!important;'
  + 'caret-color:transparent!important;scroll-behavior:auto!important}';

// Runs in the page before any of its own scripts. Frozen: Date / Date.now at the capture's
// T0, performance.now, Math.random (a fixed-seed PRNG, not a constant: code that loops
// until it draws a new value must still terminate), crypto.randomUUID.
function inPage({ t0, css }) {
  const RealDate = Date;
  // A function, not a class: page code calls `Date()` without `new` (it returns a string),
  // and a class constructor throws on that, which would break the reference's own
  // scripts during capture.
  // Constructed with new.target and given its own prototype, so an instance's
  // `constructor` is FrozenDate: `new Date().constructor.now()` must read t0, not the
  // live clock.
  function FrozenDate(...a) {
    if (!new.target) return new RealDate(t0).toString();
    return Reflect.construct(RealDate, a.length === 0 ? [t0] : a, new.target);
  }
  FrozenDate.prototype = Object.create(RealDate.prototype, {
    constructor: { value: FrozenDate, writable: true, configurable: true },
  });
  Object.setPrototypeOf(FrozenDate, RealDate);
  FrozenDate.now = () => t0;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  window.Date = FrozenDate;
  const perfStart = 0;
  performance.now = () => perfStart;

  let seed = 0x5eed;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  if (window.crypto && crypto.randomUUID) {
    let n = 0;
    crypto.randomUUID = () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`;
  }

  const addStyle = () => {
    const st = document.createElement('style');
    st.id = '__determinism_lock';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.documentElement) addStyle();
  else new MutationObserver((_, o) => {
    if (document.documentElement) { o.disconnect(); addStyle(); }
  }).observe(document, { childList: true });
}

/**
 * Apply the lock to `cdp`'s page. `t0` is the capture's frozen clock (a Date or ISO
 * string). `timezoneId` pins Intl; it defaults to RL_TZ, then UTC.
 */
export async function applyLock(cdp, t0, timezoneId = process.env.RL_TZ || 'UTC') {
  const t0ms = new Date(t0).getTime();
  await cdp.send('Emulation.setDeviceMetricsOverride', LOCK_VIEWPORT);
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId });
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${inPage.toString()})(${JSON.stringify({ t0: t0ms, css: LOCK_CSS })});`,
  });
}
