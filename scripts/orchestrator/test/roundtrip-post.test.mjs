// write_roundtrip read-back by a read POST (a multi_read that returns data): it must pass when
// the write lands, fail when the server answers 200 and drops it, and never send a read-back
// the request classifier calls a write. The GET form keeps working.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { caller, checkExpect, isReadRequest, readRequest } from "../../qa/roundtrip_lib.mjs";

/** A clone API: POST /api/people writes (or, `drop`, answers 200 and keeps nothing); POST .../multi_read and GET read. */
function api({ drop = false } = {}) {
  const people = new Map([[1, { id: 1, name: "Alex Doe" }]]);
  const sent = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      sent.push(`${req.method} ${req.url}`);
      const json = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
      if (req.method === "POST" && req.url === "/api/people") {
        const p = JSON.parse(body);
        if (!drop) people.set(p.id, p);
        return json({ ok: true });
      }
      if (req.method === "POST" && req.url === "/api/people/multi_read") return json({ items: JSON.parse(body).ids.map((id) => people.get(id) ?? null) });
      if (req.method === "POST" && req.url === "/api/people/bulk_update") return json({ items: [...people.values()] });
      if (req.method === "GET" && req.url.startsWith("/api/people/")) return json(people.get(+req.url.split("/").pop()) ?? {});
      res.writeHead(404).end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, sent, base: `http://127.0.0.1:${server.address().port}` })));
}

const ROW = {
  name: "add a person",
  write: { method: "POST", path: "/api/people", body: { id: 2, name: "Sam Rivera" } },
  expect: [
    { method: "POST", path: "/api/people/multi_read", body: { ids: [2] }, pointer: "/items/0/name", equals: "Sam Rivera" },
    { read: { method: "POST", path: "/api/people/multi_read", body: { ids: [1, 2] } }, contains: "Sam Rivera" },
    { path: "/api/people/2", pointer: "/name", equals: "Sam Rivera" },
  ],
};

async function roundTrip(app, row) {
  const call = caller(app.base);
  const w = await call(row.write.method, row.write.path, row.write.body);
  assert.equal(w.status, 200);
  const fails = [];
  for (const e of row.expect) fails.push(...(await checkExpect(e, call, { api: app.base })));
  return fails;
}

test("read-back request: GET by default; a multi_read POST is a read, a bulk_update POST is not", () => {
  assert.deepEqual(readRequest({ path: "/api/x" }), { method: "GET", path: "/api/x", body: undefined });
  assert.equal(readRequest(ROW.expect[1]).method, "POST");
  assert.equal(isReadRequest(readRequest(ROW.expect[0])).ok, true);
  assert.equal(isReadRequest({ method: "POST", path: "/api/people/bulk_update", body: { ids: [2] } }).ok, false);
  assert.equal(isReadRequest({ method: "POST", path: "/api/people/bulk_update", body: {} }, { allowPost: [/bulk_update$/] }).ok, true);
});

test("write round trip read back by a POST multi_read: passes when the write lands, fails when the server drops it", async () => {
  const good = await api();
  try {
    assert.deepEqual(await roundTrip(good, ROW), []);
    assert.ok(good.sent.includes("POST /api/people/multi_read"), "the read-back POST was sent");
  } finally {
    good.server.close();
  }
  const dropped = await api({ drop: true });
  try {
    const fails = await roundTrip(dropped, ROW);
    assert.equal(fails.length, 3, fails.join("\n"));
    assert.match(fails[0], /^read POST \/api\/people\/multi_read\/items\/0\/name = undefined, wrote "Sam Rivera"$/);
    assert.match(fails[1], /^read POST \/api\/people\/multi_read does not contain "Sam Rivera"$/);
    assert.match(fails[2], /^read \/api\/people\/2\/name = undefined, wrote "Sam Rivera"$/);
  } finally {
    dropped.server.close();
  }
});

test("a read-back the classifier calls a write is refused, never sent", async () => {
  const app = await api();
  try {
    const fails = await checkExpect({ method: "POST", path: "/api/people/bulk_update", body: { ids: [2] }, contains: "x" }, caller(app.base), { api: app.base });
    assert.match(fails[0], /is not a read .*not sent/);
    assert.ok(!app.sent.some((s) => s.includes("bulk_update")));
  } finally {
    app.server.close();
  }
});
