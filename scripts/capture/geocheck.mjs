import { chromium } from 'playwright';
const b = await chromium.launch();
const c = await b.newContext({ viewport:{width:1440,height:900} });   // clean: no storageState
const p = await c.newPage();
await p.goto('https://www.espn.com/', { waitUntil:'domcontentloaded', timeout:45000 });
await p.waitForTimeout(5000);
const r = await p.evaluate(() => ({
  url: location.href,
  title: document.title,
  nav: (document.querySelector('header')?.innerText||'').replace(/\n+/g,' | ').slice(0,220),
  cookies: document.cookie.split(';').map(s=>s.trim()).filter(s=>/^(edition|country|region)=/.test(s)),
}));
const usEdition = /www\.espn\.com/.test(r.url) && !/India/i.test(r.title);
console.log(JSON.stringify(r, null, 2));
console.log('\n' + (usEdition
  ? 'GEO OK   -> US edition held. espn reachable: stays on www.espn.com. Recon can run.'
  : 'GEO FAIL -> still ' + r.url + ' (' + r.title + '). Recon targets unreachable.'));
await b.close();
process.exit(usEdition ? 0 : 1);
