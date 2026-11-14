// Two tiny sites for Phase D: a "ref" and a "clone" that are the same app except for exactly
// three planted differences, one per channel verify must catch:
//
//   label     the home page button reads "Open filters" on the ref, "Show filters" on the clone
//   pixels    the "Status" panel is green on the ref, red on the clone
//   request   the home page reads /api/summary?period=week on the ref, ?range=week on the clone
//
// Plus a synthetic name that differs on purpose ("Alex Doe" vs "Sam Rivera") and is masked, so
// a mask is proven to hide data that is allowed to differ. The reports page is identical on
// both sides and carries a write (Save note) the clone really persists, for the round trip.

import { createServer } from "node:http";

const shell = (body, title) => `<!doctype html><html lang="en"><head><title>${title}</title>
<style>
body{font-family:sans-serif;margin:0}header{display:flex;gap:12px;padding:8px;background:#eee}
main{padding:12px}.overlay{position:fixed;z-index:50;inset:20% 30%;background:#fff;border:1px solid #333;padding:12px}
[hidden]{display:none!important}.person{display:block;width:240px;height:22px;margin:4px 0}
aside{display:block;width:160px;height:48px;margin-top:12px}
</style></head><body>
<header><nav aria-label="Main"><a href="/app/">Home</a> <a href="/app/reports">Reports</a> <a href="https://example.org/help">Help</a></nav></header>
<main>${body}</main></body></html>`;

const home = (v) => shell(`<h1>Overview</h1>
<p class="person">${v === "ref" ? "Alex Doe" : "Sam Rivera"}</p>
<p>Total: <span id="total">-</span></p>
<div><button onclick="document.getElementById('filters').hidden=false">${v === "ref" ? "Open filters" : "Show filters"}</button></div>
<aside aria-label="Status" style="background:${v === "ref" ? "#22aa77" : "#cc3333"}"></aside>
<div id="filters" class="overlay" role="dialog" aria-label="Filters" hidden><h2>Filters</h2>
<button onclick="document.getElementById('filters').hidden=true">Close</button></div>
<script>fetch('/api/summary?${v === "ref" ? "period" : "range"}=week').then((r) => r.json()).then((d) => (document.getElementById('total').textContent = d.total))</script>`, "Overview");

const reports = () => shell(`<h1>Reports</h1>
<table><thead><tr><th>Region</th><th>Count</th></tr></thead><tbody><tr><td>North</td><td>12</td></tr><tr><td>South</td><td>9</td></tr></tbody></table>
<p><label for="note">Note</label> <input id="note" name="note">
<button onclick="fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.getElementById('note').value})}).then(load)">Save note</button></p>
<p id="saved"></p>
<script>function load(){fetch('/api/notes').then((r) => r.json()).then((d) => (document.getElementById('saved').textContent = d.text || ''))} load()</script>`, "Reports");

function site(variant) {
  const state = { note: "", writes: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/api/summary") return json(200, { total: 42, label: "Week" });
    if (url.pathname === "/api/notes" && req.method === "GET") return json(200, { text: state.note });
    if (url.pathname === "/api/notes" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        state.writes.push(body);
        try {
          state.note = String(JSON.parse(body).text ?? "");
        } catch {}
        json(200, { text: state.note });
      });
      return;
    }
    const page = url.pathname === "/app/" ? home(variant) : url.pathname === "/app/reports" ? reports() : null;
    if (!page) return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

/** Start both sites; `close()` stops both. */
export async function startPair() {
  const ref = await site("ref");
  const clone = await site("clone");
  return { ref, clone, close: () => Promise.all([ref, clone].map((s) => new Promise((r) => s.server.close(r)))) };
}
