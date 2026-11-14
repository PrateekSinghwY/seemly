// Playwright for tools that live in the skill, not the repo. A bare `import 'playwright'`
// resolves from the importing file, and the skill has no node_modules, so every skill-side
// tool loads Playwright from the repo it is working on (RL_REPO, else the cwd).
//
// One place opens the reference and one place opens the clone, so the profile, the CDP
// attach and the viewport cannot drift between the explorer, the QA scripts and the gates.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPO = process.env.RL_REPO || process.cwd();
export const DISCOVERY = process.env.SEEMLY_DISCOVERY || join(REPO, "never_to_be_pushed", "discovery");
export const PROFILE = process.env.SEEMLY_PROFILE || join(DISCOVERY, "pw-profile");
export const VIEWPORT = { width: 1440, height: 900 };
// Screenshots in sRGB whatever the display: on a Mac, Chrome otherwise renders and captures in the
// display's profile (Display P3), and the pixel check would compare P3 samples against sRGB ones.
// A CDP attach cannot add flags: the window it attaches to must be launched with this flag.
export const SRGB_ARGS = ["--force-color-profile=srgb"];

let cached;
export async function playwright() {
  if (cached) return cached;
  const req = createRequire(join(REPO, "package.json"));
  let entry;
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      entry = req.resolve(name);
      break;
    } catch {}
  }
  if (!entry) throw new Error(`playwright not found from ${REPO}; run \`pnpm add -D -w playwright\` there (or set RL_REPO)`);
  const mod = await import(pathToFileURL(entry).href);
  cached = mod.default?.chromium ? mod.default : mod;
  return cached;
}

/**
 * The reference, in the build's own browser state. `cdp` attaches to a headed window that is
 * already open (launch-profile, a manual login) instead of fighting it for the profile lock;
 * otherwise the persistent profile is launched, headless unless asked.
 * `isolate` gives an attached tool its own context carrying the window's login.
 * `storageState` (or SEEMLY_STORAGE_STATE) launches a fresh browser with a saved login instead.
 * Returns `{ context, close }`; `close` never closes a browser it only attached to.
 */
export async function openReference({ cdp, headed = false, viewport = VIEWPORT, profile = PROFILE, isolate = false, storageState = process.env.SEEMLY_STORAGE_STATE } = {}) {
  const { chromium } = await playwright();
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp);
    const base = browser.contexts()[0] ?? (await browser.newContext({ viewport }));
    if (!isolate) return { context: base, close: async () => {} };
    // A context of its own with the window's login copied in, so two tools attached to one
    // window (the explorer and a QA script) never see or close each other's pages.
    // Service workers blocked: a worker started in a context another attached client did not
    // create trips a Playwright assertion in that client and kills it.
    const context = await browser.newContext({ viewport, storageState: await base.storageState(), serviceWorkers: "block" });
    return { context, close: () => context.close() };
  }
  if (storageState) {
    // A saved login (cookies copied out of the human's logged-in window): every tool gets its
    // own browser, so several can run at once without sharing one window over CDP.
    const browser = await chromium.launch({ headless: !headed, args: SRGB_ARGS });
    const context = await browser.newContext({ viewport, storageState, serviceWorkers: "block" });
    await grantClipboard(context);
    return { context, close: () => browser.close() };
  }
  if (!existsSync(profile)) console.error(`note: no profile at ${profile}; starting a fresh one (logged out)`);
  const context = await chromium.launchPersistentContext(profile, { headless: !headed, viewport, args: SRGB_ARGS });
  await grantClipboard(context);
  return { context, close: () => context.close() };
}

/** The clone: a fresh, logged-out context every time, so nothing leaks in from the reference. */
export async function openClone({ viewport = VIEWPORT } = {}) {
  const { chromium } = await playwright();
  const browser = await chromium.launch({ args: SRGB_ARGS });
  const context = await browser.newContext({ viewport });
  await grantClipboard(context);
  return { context, close: () => browser.close() };
}

/** Headless Chromium refuses clipboard writes, so every "Copy" button logged a script error. */
async function grantClipboard(context) {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
}

/** Navigation that tolerates pages which never reach network idle (polling, sockets). */
export async function settle(page, ms = 8000) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
  await page.waitForTimeout(400);
}
