import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => /espn\./.test(p.url())) || ctx.pages()[0];
await page.waitForTimeout(1500);
const r = await page.evaluate(() => {
  const hdr = document.querySelector('#global-header');
  const trig = document.querySelector('#global-user-trigger');
  const SIG = '[class*=favItem],[class*=fantasySignup],[class*=favorite],[class*=Favorite],[class*=fantasy],[class*=Fantasy],[class*=forYou],[class*=ForYou]';
  return {
    headerText: (hdr?.innerText || '').replace(/\s*\n+\s*/g,' | ').slice(0,180),
    hasLogInAffordance: /log\s*in|sign\s*in/i.test(hdr?.innerText || ''),
    userTriggerText: (trig?.innerText || '').trim().slice(0,40) || '(icon only)',
    swidCookie: /(^|;)\s*SWID=/.test(document.cookie),
    espnAuthCookie: /espn_s2|espnAuth/i.test(document.cookie),
    personalisedModules: document.querySelectorAll(SIG).length,
    viewport: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio,
  };
});
console.log(JSON.stringify(r, null, 2));
await browser.close();
