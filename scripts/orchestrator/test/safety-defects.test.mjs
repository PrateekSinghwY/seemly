// Four safety rules the 2026-11-14 sandbox walk proved weak, each against a fixture area:
//   risky names   money words match whole actions, never a noun phrase ("Current Pay Period");
//                 a money-word choice in a picker is fired and kept when it sent only reads (/pick/)
//   load reads    POSTs a page sends while it loads are reads unless clearly named writes; a page
//                 broken by an aborted load write is a retryable load-aborted gap (/ld/)
//   telemetry     analytics beacons (a pendo-like host) are never a write (/pick/)
//   session end   a route that lands on #/logout stops the walk and is never opened again (/out/)
// `O requeue --risky` re-judges elements an older rule held.
// Needs Playwright, resolved from RL_REPO; the walks are skipped when it cannot be found.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Graph } from "../graph.mjs";
import { NeverOpen, RequestClassifier, classify, sessionEndingUrl } from "../safety.mjs";
import { save as saveGraph } from "../store.mjs";
import { start } from "./fixture/site.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}
const skip = !hasPw && "playwright not resolvable from RL_REPO";
const FAST = { retries: 2, backoffMs: 50, widths: "off" };

async function setup(entry, prefix) {
  const site = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-safety-"));
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

// ---------- 1. risky names ----------

test("risky names: money words match whole actions, never a noun phrase", () => {
  for (const name of ["Previous Pay Period", "Current Pay Period", "Next Pay Period", "Pay Policies", "Pay rule", "Pay code", "Payroll", "$H-LTC Pay Mix", "3 Day Suspension without Pay", "Purchase orders", "API tokens"])
    assert.equal(classify({ name }).verdict, "ok", name);
  for (const name of ["Pay now", "Pay", "Pay $40.00", "Pay invoice", "Make payment", "Buy now", "Purchase", "Checkout", "Subscribe", "Transfer funds", "Refund", "Charge card", "Upgrade plan", "Uses 5 credits"])
    assert.equal(classify({ name }).verdict, "risky", name);
  for (const name of ["Delete", "Delete this row", "Send", "Invite"]) assert.match(classify({ name }).why, /deletion or messaging/, name);
  assert.equal(classify({ name: "Buy more hours", role: "option", inPicker: true }).choice, true, "a money-word choice in a picker is fired and judged");
  assert.equal(classify({ name: "Buy more hours", role: "button" }).choice, undefined, "a button is not a choice");
  assert.equal(classify({ name: "Delete", role: "option", inPicker: true }).choice, undefined, "deletion stays held even in a picker");
});

test("risky names: a Pay Period choice in a timeframe picker is fired, a Pay now button stays queued", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/pick/", "/pick");
  try {
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, readPosts: "auto", interactions: false, ...FAST, log: () => {} });
    const picker = nodes(w).find((n) => n.kind === "menu" && /Timeframe/.test(n.label));
    assert.ok(picker?.status === "closed", `the picker overlay was walked (${picker?.status})`);
    const rows = inventory(w, picker).candidates;
    for (const name of ["Previous Pay Period", "Current Pay Period", "Next Pay Period"]) {
      const r = rows.find((c) => c.name === name);
      assert.ok(r, `${name} probed`);
      assert.equal(r.unfired, undefined, `${name} fired (${r.unfired})`);
    }
    const buy = rows.find((c) => c.name === "Buy more hours");
    assert.equal(buy.unfired, undefined, "the money-word choice fired");
    assert.match(buy.riskyChoice, /^reads only/, "judged by what it sent");
    assert.ok(w.hits.writes.filter((x) => x === "POST /pick/api/timecards/multi_read").length >= 4, "every choice re-read the grid");
    const home = nodes(w).find((n) => n.kind === "page" && /\/pick$/.test(n.url));
    const pay = inventory(w, home).candidates.find((c) => c.name === "Pay now");
    assert.equal(pay.unfired, "skipped:risky", "Pay now is never clicked");
    const pend = jsonl(join(w.dir, "pending-writes.jsonl"));
    assert.ok(pend.some((p) => p.kind === "risky-name" && p.element.name === "Pay now"), "Pay now queued for BLOCKED");
    assert.ok(!pend.some((p) => /Pay Period|Buy more/.test(p.element.name)), "no choice queued");
    assert.ok(!w.hits.writes.includes("POST /pick/api/payments"));
  } finally {
    w.server.close();
  }
});

test("O requeue --risky: nodes with an element the new rule fires go back; their risky-name rows go", () => {
  const g = Graph.create();
  const home = g.addNode({ url: "https://a.test/app/", signature: ["home"], entry: true }).node;
  const other = g.addNode({ url: "https://a.test/app/b", signature: ["b"] }).node;
  g.addEdge({ from: home.id, to: other.id, kind: "click", element: { name: "B" } });
  const dir = mkdtempSync(join(tmpdir(), "requeue-risky-"));
  const inv = (n, names) => {
    mkdirSync(join(dir, "nodes", n.id), { recursive: true });
    writeFileSync(join(dir, "nodes", n.id, "inventory.json"), JSON.stringify({ candidates: names.map((name) => ({ role: "option", name, css: `#${name.length}`, outcome: "skipped:risky", unfired: "skipped:risky" })), interactions: [] }));
    n.info = { artifacts: join("nodes", n.id) };
  };
  inv(home, ["Current Pay Period", "Delete"]);
  inv(other, ["Delete this row"]);
  g.next();
  g.setStatus(home.id, "closed");
  g.frontier.delete(other.id);
  g.setStatus(other.id, "closed");
  g.data.templates[home.template].seenKeys = ["option|Current Pay Period|x"];
  saveGraph(g, dir);
  const row = (name) => JSON.stringify({ key: name, kind: "risky-name", node: home.id, element: { role: "option", name }, why: `name reads as money, messaging or deletion: "${name}"`, blocked: [] });
  writeFileSync(join(dir, "pending-writes.jsonl"), [row("Current Pay Period"), row("Delete")].join("\n") + "\n");
  const out = execFileSync(process.execPath, [join(here, "..", "run.mjs"), "requeue", "--risky", "--dir", dir], { encoding: "utf8" });
  assert.match(out, /requeued 1 node\(s\): 1 of 3 element\(s\)/);
  const saved = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
  assert.equal(saved.nodes[home.id].status, "frontier");
  assert.equal(saved.nodes[other.id].status, "closed", "a node whose only held element is still risky stays closed");
  assert.deepEqual(saved.templates[home.template].seenKeys, [], "template sampling forgets, so the element is not skipped as seen");
  assert.deepEqual(jsonl(join(dir, "pending-writes.jsonl")).map((p) => p.element.name), ["Delete"]);
});

// ---------- 2. reads sent while a page loads ----------

test("load reads: a POST sent while a page loads is a read unless its name is a clear write", () => {
  const c = new RequestClassifier({ readPosts: "auto" });
  const v = (path, phase) => c.classify({ method: "POST", url: `https://x.test${path}`, postData: "{}", phase }).verdict;
  for (const p of ["/schedule/action-config", "/schedule/permissions", "/schedule/partial-content", "/common/gotoconfig", "/x/getappconfig"]) assert.equal(v(p, "action"), "read", p);
  assert.equal(v("/x/saveconfig", "action"), "write", "a write verb glued to config is a write");
  assert.equal(v("/auth-migration-banners/post", "action"), "write", "after an action, post names a write");
  assert.equal(v("/auth-migration-banners/post", "load"), "read", "at load it does not");
  assert.equal(v("/x/session-context", "load"), "read");
  assert.equal(v("/x/session-context", "action"), "write", "a load rule applies at load only");
  assert.equal(v("/x/visits/update", "load"), "write", "a clear write verb is aborted at load too");
  assert.equal(c.classify({ method: "POST", url: "https://x.test/x/a", postData: JSON.stringify({ action: "delete" }), phase: "load" }).verdict, "write", "a body naming a write wins at load");
  assert.equal(new RequestClassifier({ readPosts: "off" }).classify({ method: "POST", url: "https://x.test/x/session-context", phase: "load" }).verdict, "write", "--read-posts off: no POST is a read");
});

test("load reads: pages whose content needs load-time POSTs render and walk fully; a page broken by an aborted load write is a retryable gap", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/ld/", "/ld");
  const before = w.hits.writes.length;
  try {
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, readPosts: "auto", interactions: false, ...FAST, log: () => {} });
    const sent = w.hits.writes.slice(before);
    for (const p of ["POST /ld/x/action-config", "POST /ld/banners/post", "POST /ld/session-context"]) assert.ok(sent.includes(p), `${p} reached the server`);
    assert.ok(!sent.includes("POST /ld/api/visits/update"), "a clear load write never left the browser");
    assert.ok(!sent.includes("POST /ld/api/session/update"));
    const home = nodes(w).find((n) => n.kind === "page" && /\/ld$/.test(n.url));
    const detail = nodes(w).find((n) => n.kind === "page" && /\/ld\/detail$/.test(n.url));
    assert.equal(home.status, "closed");
    assert.ok(inventory(w, home).candidates.some((c) => c.name === "Open detail"), "home drew its content");
    assert.equal(detail?.status, "closed", `detail walked, not bounded (${detail?.status} ${detail?.detail ?? ""})`);
    assert.ok(inventory(w, detail).candidates.some((c) => c.name === "Reload"), "detail drew its content");
    const opens = edges(w).filter((e) => e.from === home.id && e.to === detail.id);
    assert.ok(opens.length && opens.every((e) => e.kind !== "write"), `Open detail is not a write (${opens.map((e) => e.kind)})`);
    assert.ok(opens.some((e) => e.loadAborted?.some((x) => /visits\/update/.test(x))), "the load write is noted on the edge");
    const broken = nodes(w).find((n) => /\/ld\/broken$/.test(n.url));
    assert.equal(broken.status, "gap");
    assert.equal(broken.gapReason.code, "load-aborted");
    assert.equal(broken.gapReason.retryable, true);
    assert.ok(w.ex.retryableGaps(w.g).includes(broken.id), "requeue --gaps retries it");
    const rules = jsonl(join(w.dir, "allowed-posts.jsonl")).filter((r) => r.learned === "load");
    assert.ok(rules.some((r) => r.rule === "POST /ld/banners/post (load)") && rules.some((r) => r.rule === "POST /ld/session-context (load)"), "load rules logged");
    const pend = jsonl(join(w.dir, "pending-writes.jsonl"));
    assert.ok(pend.some((p) => p.kind === "write" && p.blocked.some((b) => /visits\/update/.test(b.url) && b.phase === "load")), "the aborted load write is queued");
  } finally {
    w.server.close();
  }
});

test("load reads: requeue --gaps takes back a node bounded as write-only when its writes were page-load reads", () => {
  const g = Graph.create();
  Object.assign(g.data.meta, { origin: "https://a.test" });
  const home = g.addNode({ url: "https://a.test/wfd/home", signature: ["home"], entry: true }).node;
  const sched = g.addNode({ url: "https://a.test/schedule", signature: ["s"] }).node;
  const real = g.addNode({ url: "https://a.test/thing", signature: ["t"] }).node;
  g.addEdge({ from: home.id, to: sched.id, kind: "write", element: { name: "Schedule" }, request: { method: "POST", url: "https://a.test/schedule/action-config" } });
  g.addEdge({ from: home.id, to: real.id, kind: "write", element: { name: "Save" }, request: { method: "POST", url: "https://a.test/api/thing/update" } });
  g.next();
  g.setStatus(home.id, "closed");
  for (const n of [sched, real]) {
    g.frontier.delete(n.id);
    g.setStatus(n.id, "bounded", "reached only through a write: see pending-writes.jsonl");
    n.bound = "reached only through a write";
  }
  const dir = mkdtempSync(join(tmpdir(), "requeue-wo-"));
  saveGraph(g, dir);
  const out = execFileSync(process.execPath, [join(here, "..", "run.mjs"), "requeue", "--gaps", "--dir", dir], { encoding: "utf8" });
  assert.match(out, /requeued 2 node\(s\) reached only through page-load writes/);
  const saved = JSON.parse(readFileSync(join(dir, "graph.json"), "utf8"));
  assert.equal(saved.nodes[sched.id].status, "frontier");
  assert.equal(saved.nodes[home.id].status, "frontier", "its opener is walked again");
  assert.equal(saved.nodes[real.id].status, "bounded", "a real write stays bounded");
  assert.ok(!Object.values(saved.edges).some((e) => e.to === sched.id), "the stale write edge is gone");
});

// ---------- 3. analytics beacons ----------

test("telemetry: analytics hosts and third-party beacon paths are telemetry, never a write", () => {
  const c = new RequestClassifier({ readPosts: "auto", origin: "https://app.example.com" });
  const v = (url, m = "POST") => c.classify({ method: m, url, postData: "x=1" }).verdict;
  for (const u of ["https://data.pendo.io/data/ptm.gif", "https://api.segment.io/v1/t", "https://www.google-analytics.com/g/collect", "https://api-js.mixpanel.com/track/", "https://api2.amplitude.com/2/httpapi", "https://in.hotjar.com/api/v2/client", "https://o1.ingest.sentry.io/api/5/envelope/", "https://browser-intake-datadoghq.com/api/v2/rum", "https://bam.nr-data.net/events/1/x", "https://col.eum-appdynamics.com/eumcollector/beacons", "https://rs.fullstory.com/rec/bundle", "https://heapanalytics.com/h"])
    assert.equal(v(u), "telemetry", u);
  assert.equal(v("https://data.pendo.io/agent/pendo.js", "GET"), "telemetry", "every request to an analytics host");
  assert.equal(v("https://metrics.vendor.net/v1/events"), "telemetry", "/events on a third-party host");
  assert.equal(v("https://app.example.com/api/events"), "write", "/events on the app's own host is not a beacon");
  assert.equal(v("https://cdn.example.com/v1/track"), "telemetry", "track is a beacon word anywhere");
});

test("telemetry: a pendo-like beacon after a click is not a write", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/pick/", "/pick");
  try {
    await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 3, readPosts: "auto", interactions: false, ...FAST, log: () => {} });
    const home = nodes(w).find((n) => n.kind === "page" && /\/pick$/.test(n.url));
    const show = inventory(w, home).candidates.find((c) => c.name === "Show summary");
    assert.ok(show && show.outcome !== "write-attempt", `Show summary is not a write attempt (${show?.outcome})`);
    assert.deepEqual(show.blocked ?? [], [], "nothing it sent was blocked as a write");
    assert.ok(!edges(w).some((e) => e.from === home.id && e.element.name === "Show summary" && e.kind === "write"), "its edge is not a write");
    assert.ok(!jsonl(join(w.dir, "pending-writes.jsonl")).some((p) => p.blocked?.some((b) => /pendo/.test(b.url))), "no pending row for the beacon");
  } finally {
    w.server.close();
  }
});

// ---------- 4. a route that signs the session out ----------

test("session end: logout-like URLs and the never-open list", () => {
  assert.ok(sessionEndingUrl("https://h/forecast#/logout"));
  assert.ok(sessionEndingUrl("https://h/sso/saml/logout?x=1"));
  assert.ok(sessionEndingUrl("https://h/app#/sign-out"));
  assert.ok(!sessionEndingUrl("https://h/forecast"));
  assert.ok(!sessionEndingUrl("https://h/layout/outline"));
  const dir = mkdtempSync(join(tmpdir(), "never-open-"));
  const nv = new NeverOpen(join(dir, "never-open.jsonl"));
  nv.add("https://h/forecast", { why: "test" });
  nv.add("https://h/app#/forecast?d=1", { why: "test" });
  const again = new NeverOpen(join(dir, "never-open.jsonl"));
  assert.ok(again.match("https://h/forecast") && again.match("https://h/forecast#/logout") && again.match("https://h/forecast?x=1"));
  assert.ok(!again.match("https://h/forecasts") && !again.match("https://h/forecast2"));
  assert.ok(again.match("https://h/app#/forecast/week"), "a hash route is barred by its route");
  assert.ok(!again.match("https://h/app#/schedule"), "the rest of a hash-routed app is not");
});

test("session end: a route that lands on #/logout stops the walk; the next walk never opens it and walks the rest", { skip, timeout: 300_000 }, async () => {
  const w = await setup("/out/", "/out");
  try {
    await assert.rejects(w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, ...FAST, log: () => {} }), (e) => e instanceof w.ex.SessionEnding && e instanceof w.ex.SessionLost);
    assert.equal(w.hits.forecast, 1);
    const never = jsonl(join(w.dir, "never-open.jsonl"));
    assert.equal(never.length, 1);
    assert.match(never[0].url, /\/out\/forecast$/);
    assert.match(never[0].landed, /#\/logout$/);
    const home = nodes(w).find((n) => n.kind === "page" && /\/out$/.test(n.url));
    assert.equal(home.status, "frontier", "the node in hand goes back for after the login");
    const fc = nodes(w).find((n) => /\/out\/forecast$/.test(n.url));
    assert.equal(fc.status, "gap");
    assert.equal(fc.gapReason.code, "session-ending");
    assert.equal(fc.gapReason.retryable, false);
    assert.ok(edges(w).some((e) => e.from === home.id && e.to === fc.id && e.kind === "session-ending"), "the opener edge is session-ending");
    assert.equal(w.g.route(fc.id), null, "never part of a replay route");
    // Logged in again: a new walk never opens it and closes the rest.
    w.hits.outLoggedOut = false;
    const r = await w.ex.explore(w.g, w.dir, { profile: w.profile, maxNodes: 20, ...FAST, log: () => {} });
    assert.ok(r.closed, "closed");
    assert.equal(w.hits.forecast, 1, "never opened again");
    for (const p of ["/out/team", "/out/reports"]) assert.equal(nodes(w).find((n) => n.url.endsWith(p))?.status, "closed", p);
    await assert.rejects(w.ex.readEntry(w.g, `${w.base}/out/forecast`, { profile: w.profile, dir: w.dir }), w.ex.NeverOpenError, "not even as an entry");
    assert.equal(w.hits.forecast, 1);
  } finally {
    w.server.close();
  }
});
