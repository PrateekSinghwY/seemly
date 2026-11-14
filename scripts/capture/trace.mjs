import { chromium } from 'playwright';
const b = await chromium.launch({ args: ["--force-color-profile=srgb"] });
const c = await b.newContext({ viewport:{width:1440,height:900} });
const p = await c.newPage();
const reqs = [];
p.on('request', r => reqs.push(r.url()));
const hops = [];
p.on('framenavigated', f => { if (f === p.mainFrame()) hops.push(f.url()); });
await p.goto('https://www.espn.com/', { waitUntil:'domcontentloaded', timeout:45000 });
await p.waitForTimeout(6000);

const idx = reqs.findIndex(u => /espn\.in/.test(u));
console.log('HOPS:', JSON.stringify(hops));
console.log('\nREQUESTS BEFORE FIRST espn.in (last 25):');
console.log(reqs.slice(Math.max(0, idx-25), idx).filter(u=>!/\.(png|jpg|svg|css|woff2?)/.test(u)).join('\n'));
console.log('\nGEO-LOOKING ENDPOINTS:');
console.log([...new Set(reqs.filter(u=>/geo|edition|country|region|location|cdn\.registerdisney|espncdn.*config/i.test(u)))].slice(0,15).join('\n'));
await b.close();
