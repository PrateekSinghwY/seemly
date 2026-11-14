// The API half of write_roundtrip.mjs, without a browser: send a request, and judge one `expect`
// row of a writes spec against what the clone reads back.
//
// An `expect` row is a read request plus what it must return:
//   { "path": "/api/listings/12", "pointer": "/name", "equals": "Harbor Loft" }            GET
//   { "method": "POST", "path": "/api/v1/people/multi_read", "body": { "ids": [12] },
//     "contains": "Harbor Loft" }                                                        a read POST
// (`read: { method, path, body }` nested in the row works the same.) A non-GET read is sent only
// when the request classifier (orchestrator/safety.mjs, read-posts auto) calls it a read, or an
// `allowPost` regex names it: a read-back that would itself write is refused, never sent.

import { RequestClassifier } from "../orchestrator/safety.mjs";

/** `call(method, path, body)` against `api`: `{ status, text, json }`. */
export function caller(api) {
  return async (method, path, body) => {
    const res = await fetch(new URL(path, api), { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json };
  };
}

/** RFC 6901 pointer. */
export function at(doc, pointer) {
  if (!pointer) return doc;
  return pointer.split("/").slice(1).reduce((v, k) => (v == null ? undefined : v[k.replace(/~1/g, "/").replace(/~0/g, "~")]), doc);
}

/** The read request of an `expect` row: `{ method, path, body }`. */
export function readRequest(e) {
  const r = e.read ?? e;
  return { method: String(r.method ?? "GET").toUpperCase(), path: r.path, body: r.body };
}

/** Is this read-back request a read? `{ ok, why }`, by the same classifier the walker uses. */
export function isReadRequest({ method, path, body }, { api = "http://127.0.0.1", allowPost = [] } = {}) {
  const c = new RequestClassifier({ allowPost, readPosts: "auto" }).classify({ method, url: new URL(path, api).href, postData: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) });
  return { ok: c.verdict === "read", why: c.why };
}

/** Failures (strings) of one `expect` row: the read-back request, then `equals` at `pointer` or `contains`. */
export async function checkExpect(e, call, { api, allowPost = [] } = {}) {
  const req = readRequest(e);
  const label = `${req.method === "GET" ? "" : `${req.method} `}${req.path}`;
  if (req.method !== "GET") {
    const r = isReadRequest(req, { api, allowPost });
    if (!r.ok) return [`read ${label} is not a read (${r.why}): not sent; name the read in the path or body, or pass --allow-post`];
  }
  const g = await call(req.method, req.path, req.body);
  if (g.status < 200 || g.status >= 300) return [`read ${label} -> ${g.status}`];
  if ("equals" in e && JSON.stringify(at(g.json, e.pointer)) !== JSON.stringify(e.equals)) return [`read ${label}${e.pointer ?? ""} = ${JSON.stringify(at(g.json, e.pointer))}, wrote ${JSON.stringify(e.equals)}`];
  if ("contains" in e && !g.text.includes(e.contains)) return [`read ${label} does not contain "${e.contains}"`];
  return [];
}
