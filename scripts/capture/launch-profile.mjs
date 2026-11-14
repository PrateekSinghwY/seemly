import { chromium } from 'playwright';
const REPO = process.env.RL_REPO || process.cwd();   // repo root; set RL_REPO or run from the repo

const ROOT    = REPO + '/never_to_be_pushed/discovery';
const PROFILE = ROOT + '/pw-profile';
const VPN     = ROOT + '/extensions/fhggeljlcambnphlgjbgnenndddhldkg';   // Planet VPN — US edition
const ADBLOCK = ROOT + '/extensions/cfhdojbkjhnklbpkdaibdccddilifddb';   // Adblock Plus
const EXT     = [VPN, ADBLOCK].join(',');

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: null,
  args: [
    '--window-size=1920,1080',
    '--remote-debugging-port=9222',          // so later steps attach instead of relaunching
    '--force-color-profile=srgb',            // sRGB screenshots on a P3 display (lib/pw.mjs SRGB_ARGS)
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.espn.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

const r = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  nav: (document.querySelector('#global-nav')?.innerText || '').replace(/\s*\n+\s*/g, ' | ').slice(0, 200),
  cookies: document.cookie.split(';').map(s => s.trim()).filter(s => /^(edition|country|region)=/.test(s)),
}));
const US = /www\.espn\.com/.test(r.url) && !/India/i.test(r.title);
console.log(JSON.stringify(r, null, 2));
console.log(US ? '\nGEO OK   -> US edition held in the persistent profile.'
              : '\nGEO FAIL -> still ' + r.url);
console.log('CDP endpoint: http://127.0.0.1:9222');
console.log('WINDOW OPEN, waiting');
await new Promise(() => {});
