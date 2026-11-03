// End to end against a real browser and the fixture app. Needs Playwright, resolved from
// RL_REPO (a clone repo with playwright installed); skipped when it cannot be found.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { start } from "./fixture/site.mjs";

const repo = process.env.RL_REPO || process.cwd();
// Under the eval runner a missing browser is a failure, never a vacuous skip.
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let hasPw = true;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
} catch {
  hasPw = false;
}

test("explore walks the fixture to a closed graph without writing anything", { skip: !hasPw && "playwright not resolvable from RL_REPO", timeout: 600_000 }, async () => {
  const { server, hits, base } = await start();
  const dir = mkdtempSync(join(tmpdir(), "seemly-explore-"));
  const profile = join(dir, "profile");
  const { open, save } = await import("../store.mjs");
  const { explore, readEntry } = await import("../explore.mjs");
  const { plan } = await import("../build.mjs");
  try {
    const g = open(dir, {});
    Object.assign(g.data.meta, { target: `${base}/app/`, origin: base, prefix: "/app" });
    await readEntry(g, `${base}/app/`, { profile });
    save(g, dir);

    const r = await explore(g, dir, { profile, maxNodes: 80, log: () => {} });
    assert.ok(r.closed, `graph closed (frontier ${g.frontier.size})`);

    const nodes = Object.values(g.data.nodes);
    const by = (pred) => nodes.filter(pred);
    assert.equal(hits.logout, 0, "logout never visited");
    assert.deepEqual(hits.writes, [], "no write reached the server");

    assert.equal(by((n) => n.kind === "modal" && /Filters/.test(n.label)).length, 1, "filters modal found once");
    assert.ok(by((n) => n.kind === "modal" && /Edit listing/.test(n.label)).length >= 1, "edit modal on a detail page");
    assert.ok(by((n) => n.kind === "menu").length >= 1, "settings menu found");
    assert.ok(by((n) => n.kind === "state" && /Details/.test(n.label)).length === 1, "tab state found");
    assert.ok(by((n) => /settings\/profile/.test(n.url)).length === 1, "menu item destination reached");
    const tour = by((n) => n.state === "on-load:Welcome tour");
    assert.equal(tour.length, 1, "an overlay open on load is its own node");
    assert.ok(Object.values(g.data.edges).some((e) => e.to === tour[0].id && e.kind === "redirect"), "reached from its page for free");
    assert.ok(by((n) => n.status === "gap" && /example\.org/.test(n.url)).length === 1, "external link is a gap");

    const details = by((n) => n.kind === "page" && /\/app\/listings\/\d+$/.test(n.url));
    assert.ok(details.length >= 2 && details.length < 40, `rows sampled, not all walked (${details.length})`);
    assert.equal(new Set(details.map((n) => n.template)).size, 1, "detail pages are one template");
    assert.ok(details.filter((n) => n.info.templateSeen).length >= 1, "members after the first two fire only what is new to the template");
    const list = nodes.find((n) => /\/app\/listings$/.test(n.url));
    assert.ok(list.info.sampled?.length, "the sampled row group is recorded on the list node");

    const pending = readFileSync(join(dir, "pending-writes.jsonl"), "utf8");
    assert.match(pending, /Delete all/, "risky control queued, not clicked");
    const rows = pending.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.some((r) => r.blocked.some((b) => b.method === "PUT" && /\/api\/listings\//.test(b.url))), "a write a click attempted is recorded with its request");
    assert.ok(existsSync(join(dir, list.info.artifacts, "inventory.json")));

    const st = plan(g);
    assert.equal(st.order[0], "shell");
    assert.ok(Object.values(st.units).some((u) => u.kind === "template" && u.members.length === details.length));
  } finally {
    server.close();
  }
});
