#!/usr/bin/env node
// Copy a logged-in window's cookies (and chosen localStorage keys) into a Playwright storageState
// file, over raw CDP: no Playwright attach, so a site's service worker cannot crash the attach.
// Every tool then launches its own browser with the login (SEEMLY_STORAGE_STATE), several at once.
//
//   node export-login.mjs --cdp http://127.0.0.1:9223 --domain example.com --out never_to_be_pushed/discovery/auth-ref.json \
//        [--origin https://app.example.com --local key=value]...
// The file holds live session cookies: keep it under never_to_be_pushed/ (git-excluded), never commit it.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: { cdp: { type: "string", default: "http://127.0.0.1:9222" }, domain: { type: "string" }, out: { type: "string" }, origin: { type: "string" }, local: { type: "string", multiple: true, default: [] } },
});
if (!o.domain || !o.out) throw new Error("give --domain <site domain> --out <file>");
const v = await (await fetch(`${o.cdp}/json/version`)).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const call = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    ws.addEventListener("message", function h(e) {
      const m = JSON.parse(e.data);
      if (m.id === id) {
        ws.removeEventListener("message", h);
        res(m.result);
      }
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
const { cookies } = await call("Storage.getCookies");
const mine = cookies.filter((c) => c.domain.replace(/^\./, "").endsWith(o.domain));
const state = {
  cookies: mine.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.session ? -1 : c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite ?? "Lax" })),
  origins: o.origin ? [{ origin: o.origin, localStorage: o.local.map((kv) => ({ name: kv.split("=")[0], value: kv.split("=").slice(1).join("=") })) }] : [],
};
writeFileSync(o.out, JSON.stringify(state));
console.log(`saved ${state.cookies.length} cookies for ${o.domain} to ${o.out} (names only: ${state.cookies.map((c) => c.name).join(", ").slice(0, 200)})`);
ws.close();
process.exit(0);
