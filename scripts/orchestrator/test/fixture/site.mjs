// A small app with every surface kind the explorer has to find: a shell with nav, an external
// link, a logout link, a modal with a write inside, tabs, a hover/click menu, a 40-row table
// whose rows navigate by script, detail pages with an edit modal, and a delete-everything
// button. It counts what reached the server, so a test can prove nothing was written.
//
// Three more areas, each walked from its own entry so the /app walk is unchanged:
//   /hub/    a plain fixed menu box (no dialog role) the app re-renders on every click and
//            keeps open across reloads (only its Close control shuts it), one that nothing closes (/hub/sticky), read POSTs a
//            URL or body names as reads, a telemetry beacon, a real write, and a websocket RPC
//            that reads on load and writes on a click
//   /flaky/  a page that answers 503 three times before it works, and one that never does
//   /sess/   a control that ends the session; every page after it redirects to /login

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const ROWS = 40;

const shell = (body, title) => `<!doctype html><html><head><title>${title}</title>
<style>
body{font-family:sans-serif;margin:0}header{display:flex;gap:12px;padding:8px;background:#eee}
.row{cursor:pointer}.overlay{position:fixed;z-index:50;inset:20% 30%;background:#fff;border:1px solid #333;padding:12px}
[hidden]{display:none!important}.menu{position:absolute;z-index:20;background:#fff;border:1px solid #999;width:200px;height:120px}
</style></head><body>
<header><nav aria-label="Main"><a href="/app/">Home</a> <a href="/app/listings">Listings</a> <a href="/app/settings">Settings</a>
<a href="https://example.org/help">Help</a> <a href="/app/logout">Log out</a></nav></header>
<main>${body}</main></body></html>`;

const home = shell(`
<section><h1>Dashboard</h1>
<button id="open-filters" onclick="document.getElementById('filters').hidden=false">Open filters</button>
<button onclick="fetch('/api/everything',{method:'DELETE'})">Delete all</button>
<div id="filters" class="overlay" role="dialog" aria-label="Filters" hidden>
  <h2>Filters</h2><label>Min <input name="min"></label>
  <button onclick="fetch('/api/filters',{method:'POST',body:'{}'})">Apply</button>
  <button onclick="document.getElementById('filters').hidden=true">Close</button>
</div></section>
<section><div role="tablist">
  <button role="tab" aria-selected="true" onclick="show('a')">Overview</button>
  <button role="tab" aria-selected="false" onclick="show('b')">Details</button>
</div>
<div id="a"><p>Overview text</p></div>
<div id="b" hidden><table><tr><th>k</th><th>v</th></tr><tr><td>1</td><td>2</td></tr></table><ul><li>x</li><li>y</li></ul></div>
<script>function show(k){a.hidden=k!=='a';b.hidden=k!=='b'}</script></section>`, "Dashboard");

const listings = shell(`<h1>Listings</h1><table><tbody>
${Array.from({ length: ROWS }, (_, i) => `<tr class="row" onclick="location.href='/app/listings/${1000 + i}'"><td>Unit ${i + 1}</td><td>${90 + i}</td></tr>`).join("\n")}
</tbody></table>`, "Listings");

const detail = (id) => shell(`<article><h1>Unit ${id}</h1><p>Rate</p>
<button onclick="document.getElementById('edit').hidden=false">Edit</button>
<div id="edit" class="overlay" role="dialog" aria-label="Edit listing" hidden><h2>Edit listing</h2>
<input name="rate"><button onclick="fetch('/api/listings/${id}',{method:'PUT',body:'{}'})">Save</button>
<button onclick="document.getElementById('edit').hidden=true">Cancel</button></div></article>`, `Unit ${id}`);

const settings = shell(`<div id="tour" class="overlay" role="dialog" aria-label="Welcome tour"><p>New here?</p>
<button onclick="document.getElementById('tour').remove()">Skip</button></div>
<h1>Settings</h1><div style="position:relative">
<button aria-haspopup="menu" aria-expanded="false" onclick="const m=document.getElementById('m');m.hidden=!m.hidden;this.setAttribute('aria-expanded',String(!m.hidden))">Account</button>
<div id="m" class="menu" role="menu" hidden><a role="menuitem" href="/app/settings/profile">Profile</a><a role="menuitem" href="/app/settings/billing">Billing</a></div></div>`, "Settings");

const simple = (h) => shell(`<h1>${h}</h1><p>${h} page</p><form><label>Field <input></label></form>`, h);

const hubScript = (key, overlay, extra = "") => `<div id="layer"></div><script>
const KEY = ${JSON.stringify(key)};
const OVERLAY = ${JSON.stringify(overlay)};
function render() { layer.innerHTML = sessionStorage.getItem(KEY) ? OVERLAY : ""; }
const post = (u, b, t = "application/json") => fetch(u, { method: "POST", headers: { "content-type": t }, body: b }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
function show(rows) { results.innerHTML = "<table>" + rows.map((r) => "<tr><td>" + r + "</td></tr>").join("") + "</table><ul><li>a</li><li>b</li><li>c</li></ul>"; }
document.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "open") sessionStorage.setItem(KEY, "1");
  if (act === "close") sessionStorage.removeItem(KEY);
  render(); // every click re-renders the overlay layer, as a portal does
  ${extra}
});
render();
</script>`;

const hub = `<!doctype html><html><head><title>Hub</title><style>
body{font-family:sans-serif;margin:0}header{padding:8px;background:#eee}.overlay{position:fixed;z-index:50;inset:15% 25%;background:#fff;border:1px solid #333;padding:12px}
</style></head><body>
<header><nav aria-label="Main"><button data-act="open">Main Menu</button> <button data-act="help">Help</button> <a href="/hub/sticky">Sticky</a></nav></header>
<main><h1>Hub</h1>
<button data-act="search">Search employees</button> <button data-act="find">Find people</button> <button data-act="config">Open config</button>
<button data-act="track">Track usage</button> <button data-act="save">Save profile</button> <button data-act="archive">Archive record</button>
<div id="results"></div></main>
${hubScript("hub-menu", '<nav class="overlay" aria-label="Main Menu"><h2>Main Menu</h2><p>Go to</p><a href="/hub/">Home</a> <button data-act="close">Close</button></nav>', `
  if (act === "search") { const r = await post("/hub/api/v1/employees/search/multi", JSON.stringify({ text: "a" })); if (r) show(r.rows); }
  if (act === "find") { const r = await post("/hub/api/people", JSON.stringify({ filter: { dept: "ops" }, pageSize: 10 })); if (r) show(r.rows); }
  if (act === "config") { const r = await post("/hub/common/gotoconfig", ""); if (r) show(r.rows); }
  if (act === "track") post("/hub/telemetry", JSON.stringify({ records: [{ action: "click" }] }));
  if (act === "save") post("/hub/api/profile", JSON.stringify({ name: "Alex Doe" }));
  if (act === "archive") ws.send(JSON.stringify({ name: "/records/archive", args: { id: 3 } }));`)}
<script>
const ws = new WebSocket("ws://" + location.host + "/hub/ws");
ws.onopen = () => {
  ws.send(JSON.stringify({ name: "/employees/get", args: { id: 1 }, id: 7 }));
  ws.send(JSON.stringify({ name: "/settings/load", args: {} }));
};
</script></body></html>`;

const sticky = `<!doctype html><html><head><title>Sticky</title><style>
body{font-family:sans-serif;margin:0}.overlay{position:fixed;z-index:50;inset:15% 25%;background:#fff;border:1px solid #333;padding:12px}
</style></head><body><main><h1>Sticky</h1><button data-act="open">Pin panel</button> <button data-act="other">Other</button><div id="results"></div></main>
${hubScript("sticky-panel", '<div class="overlay" role="dialog" aria-label="Pinned"><h2>Pinned</h2><p>Stays open</p></div>')}</body></html>`;

const plain = (title, body) => `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const flakyHome = plain("Flaky", `<h1>Flaky</h1><nav><a href="/flaky/reports">Reports</a> <a href="/flaky/down">Down</a></nav>`);
const sessHome = plain("Session", `<h1>Session</h1><button onclick="fetch('/sess/api/expire')">Expire session</button> <a href="/sess/team">Team</a>`);
const login = plain("Sign in", `<h1>Sign in</h1><form><label>User <input name="u"></label><label>Password <input type="password" name="p"></label><button type="button">Sign in</button></form>`);

/** A websocket endpoint without dependencies: RFC 6455 handshake, text frames only. */
export function acceptWs(req, socket, onText) {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const send = (text) => {
    const p = Buffer.from(text);
    const h = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
    socket.write(Buffer.concat([h, p]));
  };
  let buf = Buffer.alloc(0);
  socket.on("error", () => {});
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 15;
      let len = buf[1] & 127;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      }
      const mask = buf[1] & 128 ? buf.subarray(off, off + 4) : null;
      if (mask) off += 4;
      if (buf.length < off + len) return;
      const data = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (op === 8) return socket.end();
      if (op === 1) onText(data.toString(), send);
    }
  });
}

export function start() {
  const hits = { logout: 0, writes: [], ws: [], flaky: 0, loggedOut: false, expired: false };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method !== "GET") hits.writes.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/app/logout") hits.logout++;
    const html = (body, status = 200) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(body);
    };
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/login") return html(login);
    if (url.pathname.startsWith("/sess/")) {
      if (url.pathname === "/sess/api/expire") {
        if (!hits.expired) hits.loggedOut = hits.expired = true;
        return json({});
      }
      if (hits.loggedOut) {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` });
        return res.end();
      }
      if (url.pathname === "/sess/") return html(sessHome);
      if (url.pathname === "/sess/team") return html(plain("Team", "<h1>Team</h1><p>Members</p>"));
    }
    if (url.pathname.startsWith("/flaky/")) {
      if (url.pathname === "/flaky/") return html(flakyHome);
      if (url.pathname === "/flaky/down") return html(plain("Service Unavailable", "<h1>Service Unavailable</h1>"), 503);
      if (url.pathname === "/flaky/reports") {
        if (++hits.flaky <= 3) return html(plain("Service Unavailable", "<h1>Service Unavailable</h1>"), 503);
        return html(plain("Reports", "<h1>Reports</h1><table><tr><td>Hours</td></tr></table>"));
      }
    }
    if (url.pathname.startsWith("/hub/")) {
      if (url.pathname === "/hub/") return html(hub);
      if (url.pathname === "/hub/sticky") return html(sticky);
      if (req.method === "POST") return json({ rows: ["Alex Doe", "Sam Rivera", "Priya Natarajan"] });
    }
    const page =
      url.pathname === "/app/" ? home
      : url.pathname === "/app/listings" ? listings
      : /^\/app\/listings\/\d+$/.test(url.pathname) ? detail(url.pathname.split("/").pop())
      : url.pathname === "/app/settings" ? settings
      : url.pathname === "/app/settings/profile" ? simple("Profile")
      : url.pathname === "/app/settings/billing" ? simple("Billing")
      : null;
    if (!page) {
      res.writeHead(url.pathname.startsWith("/api/") ? 200 : 404, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  server.on("upgrade", (req, socket) => {
    if (!req.url.startsWith("/hub/ws")) return socket.destroy();
    acceptWs(req, socket, (text, send) => {
      const msg = JSON.parse(text);
      hits.ws.push(msg.name);
      if (msg.name === "/employees/get") send(JSON.stringify({ id: msg.id, data: [{ id: 1, label: "Alex Doe" }] }));
      if (msg.name === "/settings/load") send(JSON.stringify({ name: "/settings/load", data: { theme: "light" } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}
