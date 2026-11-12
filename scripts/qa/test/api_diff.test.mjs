// api_diff: id segments and {params} meet as one template; a reference endpoint the clone lacks is
// listed; a field the reference returns or sends that the clone's schema lacks is listed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cloneOps, diff, keyPaths, referenceCalls, template } from "../api_diff.mjs";

test("templates: ids and params collapse, words stay, prefixes strip", () => {
  assert.equal(template("/api/v1/persons/123/jobs"), "/api/v1/persons/{id}/jobs");
  assert.equal(template("/api/v1/persons/{person_id}"), "/api/v1/persons/{id}");
  assert.equal(template("/api/api/v1/x/multi_read", "/api"), "/api/v1/x/multi_read");
  assert.equal(template("/v1/a/3f2b9c1d-1111-2222-3333-444455556666"), "/v1/a/{id}");
  assert.deepEqual([...keyPaths({ a: { b: 1 }, items: [{ c: 2 }] })].sort(), ["a", "a.b", "items", "items[].c"]);
});

test("diff: missing endpoint, response drift and request drift found from walk and session captures", () => {
  const dir = mkdtempSync(join(tmpdir(), "seemly-apidiff-"));
  const node = join(dir, "nodes", "n1");
  mkdirSync(join(node, "xhr"), { recursive: true });
  writeFileSync(join(node, "xhr", "a.json"), JSON.stringify({ id: 1, name: "x", wage: 2 }));
  writeFileSync(join(node, "xhr", "a.req.json"), JSON.stringify({ where: { ids: [1] } }));
  writeFileSync(join(node, "inventory.json"), JSON.stringify({ id: "n1", requests: [
    { method: "POST", url: "https://ref.test/api/v1/persons/multi_read", status: 200, file: "a.json", reqFile: "a.req.json" },
    { method: "GET", url: "https://ref.test/api/v1/unknown/77", status: 200 },
  ] }));
  const ses = join(dir, "sessions", "manager", "approve-1");
  mkdirSync(join(ses, "api"), { recursive: true });
  writeFileSync(join(ses, "api", "0001.res.json"), JSON.stringify({ status: "ok" }));
  writeFileSync(join(ses, "session.jsonl"), JSON.stringify({ type: "api", seq: "0001", method: "POST", url: "https://ref.test/api/v1/timecards/9/approve", status: 200 }) + "\n");

  const spec = {
    paths: {
      "/api/api/v1/persons/multi_read": { post: {
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Req" } } } },
        responses: { 200: { content: { "application/json": { schema: { $ref: "#/components/schemas/P" } } } } },
      } },
      "/api/api/v1/timecards/{tid}/approve": { post: { responses: { 200: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" } } } } } } } } },
    },
    components: { schemas: {
      P: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } },
      Req: { type: "object", properties: { where: { type: "object", properties: { ids: { type: "array" } } } } },
    } },
  };
  const r = diff(referenceCalls([dir]), cloneOps(spec, "/api"));
  assert.deepEqual(r.missing.map((m) => m.key), ["GET /api/v1/unknown/{id}"]);
  const persons = r.matched.find((m) => m.key === "POST /api/v1/persons/multi_read");
  assert.deepEqual(persons.resMissing, ["wage"]);
  assert.deepEqual(persons.reqMissing, []);
  const approve = r.matched.find((m) => m.key === "POST /api/v1/timecards/{id}/approve");
  assert.deepEqual(approve.resMissing, []);
  assert.match(approve.where.values().next().value, /session manager\/approve-1/);
});
