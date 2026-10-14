import { chromium } from 'playwright';

const out = { cdp: null, loggedOut: null, err: null };
try {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } }); // fresh: NO storageState
  const p = await c.newPage();
  const cdp = await c.newCDPSession(p);
  const v = await cdp.send('Browser.getVersion');
  const r = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  out.cdp = { product: v.product, eval: r.result.value };

  const resp = await p.goto('https://www.espn.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(4000);

  out.loggedOut = await p.evaluate(() => {
    const txt = (document.body.innerText || '');
    const head = document.querySelector('header') || document.body;
    const headTxt = (head.innerText || '').slice(0, 1200);
    const hasLogIn = /log\s*in/i.test(headTxt) || /log\s*in/i.test(txt.slice(0, 4000));
    const imgs = [...document.querySelectorAll('header img, [class*=avatar] img, [class*=Avatar] img')]
      .map(i => i.src).filter(Boolean);
    const cookieNames = document.cookie.split(';').map(s => s.split('=')[0].trim()).filter(Boolean);
    return {
      title: document.title,
      url: location.href,
      hasLogIn,
      headerSample: headTxt.replace(/\n+/g, ' | ').slice(0, 400),
      headerImgCount: imgs.length,
      cookieNames,
      bodyChars: txt.length,
    };
  });
  out.status = resp?.status();
  await b.close();
} catch (e) { out.err = e.message; }
console.log(JSON.stringify(out, null, 2));
