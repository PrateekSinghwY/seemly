// The walker's correctness invariants, each against a fixture area built to break it:
//   pre-state    an element fires only from its node's verified pre-state (/hub/, /hub/sticky)
//   reads        read POSTs, beacons and websocket reads are not writes (/hub/)
//   websocket    socket calls are captured per node, paired, next to the HTTP reads (/hub/)
//   invariant    every element ends as an edge or a recorded reason (/hub/ + a unit check)
//   transient    a flaky 503 is retried with backoff; a gap carries a reason (/flaky/)
//   session      a login lost mid-walk stops the run, never leaves a gap (/sess/)
// Needs Playwright, resolved from RL_REPO; skipped when it cannot be found.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { classifyFrame, isWrite, pairFrames, parseFrame, RequestClassifier } from "../safety.mjs";
import { start } from "./fixture/site.mjs";

const repo = process.env.RL_REPO || process.cwd();
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";
const FAST = { retries: 3, backoffMs: 50 };

async function setup(entry, prefix) {
  const site = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-walker-"));
  const profile = join(dir, "profile");
  const { open, save } = await import("../store.mjs");
  const ex = await import("../explore.mjs");
  const g = open(dir, {});
  Object.assign(g.data.meta, { target: `${site.base}${entry}`, origin: site.base, prefix });
  await ex.readEntry(g, `${site.base}${entry}`, { profile });
  save(g, dir);
  return { ...site, dir, profile, g, ex, save };
}

const jsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const inventory = (w, n) => JSON.parse(readFileSync(join(w.dir, n.info.artifacts, "inventory.json"), "utf8"));
const nodes = (w) => Object.values(w.g.data.nodes);
const edges = (w) => Object.values(w.g.data.edges);

describe("walker on /hub/", { skip, timeout: 600_000 }, () => {
  let w;
  let home;
  before(async () => {
    w = await setup("/hub/", "/hub");
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 40, readPosts: "auto", ...FAST, log: () => {} });
    home = nodes(w).find((n) => n.kind === "page" && /\/hub$/.test(n.url));
  });
  after(() => w?.server.close());

  test("pre-state: an overlay left open is closed before the next element fires, so its edge is not misattributed", () => {
    const menu = nodes(w).filter((n) => /Main Menu/.test(n.label));
    assert.equal(menu.length, 1, "the Main Menu overlay is one node");
    assert.ok(edges(w).some((e) => e.from === home.id && e.to === menu[0].id && e.element.name === "Main Menu"), "Main Menu opens it");
    const wrong = edges(w).filter((e) => e.element.name === "Help" && e.to === menu[0].id);
    assert.deepEqual(wrong, [], "Help never points at the overlay Main Menu left open");
    const help = inventory(w, home).candidates.find((c) => c.name === "Help");
    assert.equal(help.outcome, "inert", "Help fired from the verified pre-state and opened nothing");
  });

  test("pre-state: a state that cannot be restored leaves the element unfired with a reason, not an edge", () => {
    const sticky = nodes(w).find((n) => n.kind === "page" && /\/hub\/sticky$/.test(n.url));
    assert.ok(sticky?.status === "closed", "sticky page walked");
    const other = inventory(w, sticky).candidates.find((c) => c.name === "Other");
    assert.equal(other.unfired, "state-not-restored");
    assert.deepEqual(edges(w).filter((e) => e.from === sticky.id && e.element.name === "Other"), [], "no edge for it");
    assert.equal(sticky.info.notRestored, 1);
  });

  test("reads: read POSTs (by URL and by body) and beacons are not writes; only real writes are pending", () => {
    const pend = jsonl(join(w.dir, "pending-writes.jsonl"));
    const blockedUrls = pend.flatMap((p) => p.blocked.map((b) => b.url));
    for (const read of ["/search/multi", "/api/people", "/common/gotoconfig", "/telemetry"])
      assert.ok(!blockedUrls.some((u) => u.includes(read)), `${read} is not a pending write`);
    assert.ok(pend.some((p) => p.kind === "write" && p.blocked.some((b) => b.method === "POST" && b.url.endsWith("/hub/api/profile"))), "the real write is pending");
    for (const name of ["Search employees", "Find people", "Open config"]) {
      const es = edges(w).filter((e) => e.from === home.id && e.element.name === name);
      assert.ok(es.length >= 1, `${name} has an edge`);
      // its click edge, plus the Enter activation edge (kind key) to the same result: never a write
      assert.ok(es.some((e) => e.kind === "click") && es.every((e) => ["click", "key"].includes(e.kind)), `${name} is a click, not a write`);
    }
    assert.ok(w.hits.writes.includes("POST /hub/api/v1/employees/search/multi"), "read POST reached the server");
    assert.ok(w.hits.writes.includes("POST /hub/api/people"));
    assert.ok(w.hits.writes.includes("POST /hub/common/gotoconfig"));
    assert.ok(!w.hits.writes.includes("POST /hub/api/profile"), "the write never left the browser");
    assert.ok(!w.hits.writes.includes("POST /hub/telemetry"), "the beacon never left the browser");
    const rules = jsonl(join(w.dir, "allowed-posts.jsonl")).filter((r) => r.rule);
    assert.ok(rules.some((r) => r.learned === "url" && /search\/multi/.test(r.rule)), "URL rule learned and logged");
    assert.ok(rules.some((r) => r.learned === "body" && /\/hub\/api\/people \{filter,pageSize\}/.test(r.rule)), "body rule learned and logged");
  });

  test("websocket: reads are captured per node and paired; a write call is dropped and pending", () => {
    const inv = inventory(w, home);
    const get = inv.wsReads.find((c) => c.name === "/employees/get");
    const load = inv.wsReads.find((c) => c.name === "/settings/load");
    assert.ok(get?.answered, "paired by id");
    assert.ok(load?.answered, "paired by name");
    const saved = JSON.parse(readFileSync(join(w.dir, home.info.artifacts, "ws", get.file), "utf8"));
    assert.deepEqual(saved.sent.args, { id: 1 });
    assert.equal(saved.received.data[0].id, 1);
    assert.ok(w.hits.ws.includes("/employees/get"));
    assert.ok(!w.hits.ws.includes("/records/archive"), "the socket write never reached the server");
    const pend = jsonl(join(w.dir, "pending-writes.jsonl"));
    assert.ok(pend.some((p) => p.element.name === "Archive record" && p.blocked.some((b) => b.method === "WS" && /records\/archive/.test(b.url))));
  });

  test("invariant: every element on every walked node is an edge or a recorded reason", () => {
    const walked = nodes(w).filter((n) => n.info?.artifacts);
    assert.ok(walked.length >= 3);
    for (const n of walked) {
      const inv = inventory(w, n);
      assert.equal(inv.invariant, "ok", `${n.label}: ${inv.invariant}`);
      assert.deepEqual(w.ex.nodeInvariant(inv.candidates, inv.candidates), []);
    }
  });
});

test("invariant: a missing row or an unrecorded reason keeps a node open", async () => {
  const { nodeInvariant } = await import("../explore.mjs");
  const cands = [{ role: "button", name: "A", css: "#a" }, { role: "button", name: "B", css: "#b" }, { role: "button", name: "C", css: "#c" }];
  assert.deepEqual(nodeInvariant(cands, [{ ...cands[0], outcome: "inert" }, { ...cands[1], outcome: "state", children: ["n_1"] }, { ...cands[2], outcome: "disabled", unfired: "disabled" }]), []);
  assert.equal(nodeInvariant(cands, [{ ...cands[0], outcome: "inert" }]).length, 3, "two rows missing");
  assert.equal(nodeInvariant(cands.slice(0, 1), [{ ...cands[0], outcome: "overlay", children: [] }]).length, 1, "an edge outcome needs its edge");
  assert.equal(nodeInvariant(cands.slice(0, 1), [{ ...cands[0], outcome: "skipped", unfired: "felt like it" }]).length, 1, "an unknown reason");
  assert.equal(nodeInvariant(cands.slice(0, 1), [{ ...cands[0] }]).length, 1, "no outcome at all");
});

test("reads: request and frame classification", () => {
  const c = new RequestClassifier({ readPosts: "auto" });
  const v = (url, body, m = "POST") => c.classify({ method: m, url: `https://x.test${url}`, postData: body }).verdict;
  assert.equal(v("/common/gotoconfig", ""), "read");
  assert.equal(v("/api/people", JSON.stringify({ filter: { a: 1 }, pageSize: 5 })), "read");
  assert.equal(v("/api/people", JSON.stringify({ name: "Alex Doe" })), "write", "a body that carries data is a write");
  assert.equal(v("/api/items/delete", JSON.stringify({ filter: {} })), "write", "a write word wins over a filter body");
  assert.equal(v("/x/List.do", "formAction=menu.new"), "write", "an action value naming a change wins over the URL");
  assert.equal(v("/x/rules.jsp", "com.x.ACTION=refresh"), "read");
  assert.equal(v("/x/rules.jsp", "com.x.ACTION=saveAndRefresh"), "write");
  assert.equal(v("/telemetry", "{}"), "telemetry");
  assert.equal(v("/api/list/5/items", JSON.stringify({ name: "x" })), "write", "a noun segment is not a read");
  assert.equal(v("/api/x", "", "DELETE"), "write");
  assert.equal(new RequestClassifier({ readPosts: "off" }).classify({ method: "POST", url: "https://x.test/api/search", postData: "{}" }).verdict, "write", "off: no POST is a read");
  assert.equal(isWrite({ method: "POST", url: "https://x.test/apply_read" }, [], { readPosts: "auto" }), false, "back-compat");
  assert.equal(classifyFrame(parseFrame(JSON.stringify({ name: "/x/get", args: {} }))).verdict, "read");
  assert.equal(classifyFrame(parseFrame(JSON.stringify({ name: "/x/update", args: {} }))).verdict, "write");
  assert.equal(classifyFrame(parseFrame(JSON.stringify({ name: "/x/thing", args: { a: 1 } }))).verdict, "write", "unknown call names are not sent");
  const frames = [
    { dir: "sent", data: '{"name":"/a/get","id":1}', parsed: parseFrame('{"name":"/a/get","id":1}') },
    { dir: "sent", data: '{"name":"/b/load"}', parsed: parseFrame('{"name":"/b/load"}') },
    { dir: "recv", data: '{"name":"/b/load","data":2}', parsed: parseFrame('{"name":"/b/load","data":2}') },
    { dir: "recv", data: '{"id":1,"data":1}', parsed: parseFrame('{"id":1,"data":1}') },
  ];
  assert.deepEqual(pairFrames(frames).map((p) => [p.name, p.received]), [["/a/get", '{"id":1,"data":1}'], ["/b/load", '{"name":"/b/load","data":2}']]);
});

test("transient: a flaky 503 is retried with backoff; a page that stays down is a gap with a retryable reason", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/flaky/", "/flaky");
  try {
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, ...FAST, log: () => {} });
    const reports = nodes(w).find((n) => /\/flaky\/reports$/.test(n.url));
    assert.equal(reports.status, "closed", `reports closed after retries (${reports.status} ${reports.detail ?? ""})`);
    assert.equal(reports.label, "Reports", "read off the working page, not the error page");
    assert.ok(w.hits.flaky >= 4);
    const down = nodes(w).find((n) => /\/flaky\/down$/.test(n.url));
    assert.equal(down.status, "gap");
    assert.equal(down.gapReason.code, "transient");
    assert.equal(down.gapReason.retryable, true);
    for (const n of nodes(w).filter((x) => x.status === "gap")) assert.ok(w.ex.gapReason(n)?.code, `${n.label} has a reason`);
    assert.deepEqual(w.ex.retryableGaps(w.g), [down.id]);
    assert.deepEqual(w.ex.requeueGaps(w.g), [down.id]);
    assert.equal(down.status, "frontier");
    // Legacy gaps (written before reasons existed) are classified from their detail.
    assert.equal(w.ex.gapReason({ status: "gap", detail: "explore failed twice: page.goto: net::ERR_ABORTED at https://x" }).code, "transient");
    assert.equal(w.ex.gapReason({ status: "gap", detail: "explore failed twice: HTTP 404 on https://x" }).retryable, false);
    assert.equal(w.ex.gapReason({ status: "gap", detail: "not licensed" }).code, "manual");
  } finally {
    w.server.close();
  }
});

test("session: a sign-in redirect mid-walk stops the run with the node back on the frontier, never a gap", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/sess/", "/sess");
  try {
    await assert.rejects(w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, ...FAST, log: () => {} }), w.ex.SessionLost);
    const home = nodes(w).find((n) => /\/sess$/.test(n.url));
    assert.equal(home.status, "frontier", "the node in hand goes back on the frontier");
    assert.deepEqual(nodes(w).filter((n) => n.status === "gap").map((n) => n.label), [], "nothing became a gap");
    assert.ok(!nodes(w).some((n) => /\/login/.test(n.url)), "the sign-in page is not a node");
    // Logged in again: the walk resumes and closes.
    w.hits.loggedOut = false;
    const r = await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, ...FAST, log: () => {} });
    assert.ok(r.closed, "closed after the login came back");
    assert.ok(nodes(w).some((n) => /\/sess\/team$/.test(n.url) && n.status === "closed"));
  } finally {
    w.server.close();
  }
});
