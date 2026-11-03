// A small app with every surface kind the explorer has to find: a shell with nav, an external
// link, a logout link, a modal with a write inside, tabs, a hover/click menu, a 40-row table
// whose rows navigate by script, detail pages with an edit modal, and a delete-everything
// button. It counts what reached the server, so a test can prove nothing was written.

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

export function start() {
  const hits = { logout: 0, writes: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method !== "GET") hits.writes.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/app/logout") hits.logout++;
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}
