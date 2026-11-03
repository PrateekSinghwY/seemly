import assert from "node:assert/strict";
import { test } from "node:test";

import { STATE_BOUND, admit, inScope, pathPattern, repeatGroup } from "../bound.mjs";
import { finish, nextUnit, packet, plan } from "../build.mjs";
import { Graph } from "../graph.mjs";
import { classify, isWrite } from "../safety.mjs";
import { tree } from "../views.mjs";

test("path families: ids collapse, words stay", () => {
  assert.equal(pathPattern("/listings/1234/edit"), "/listings/:id/edit");
  assert.equal(pathPattern("/u/3f2b8c1e-0b7a-4c4e-9a63-2d1f5e7c9b10"), "/u/:id");
  assert.equal(pathPattern("/reports/2026-09"), "/reports/:id");
  assert.equal(pathPattern("/settings/billing"), "/settings/billing");
  assert.equal(pathPattern("/team/nba-12"), "/team/:id");
});

test("scope: same origin under the prefix only", () => {
  const s = { origin: "https://a.test", prefix: "/app" };
  assert.ok(inScope("https://a.test/app", s));
  assert.ok(inScope("https://a.test/app/x?y=1", s));
  assert.ok(!inScope("https://a.test/apple", s));
  assert.ok(!inScope("https://b.test/app", s));
  assert.ok(!inScope("mailto:x@example.com", s));
  const multi = { origin: "https://a.test", prefix: ["/pricing", "/reports"] };
  assert.ok(inScope("https://a.test/reports/12", multi));
  assert.ok(!inScope("https://a.test/portfolio", multi));
});

test("STATE_BOUND: a path family keeps 30 members, the rest are recorded out of range", () => {
  const b = {};
  for (let i = 0; i < STATE_BOUND; i++) assert.ok(admit(b, `https://a.test/l/${i}`).ok);
  const over = admit(b, "https://a.test/l/999");
  assert.equal(over.ok, false);
  assert.match(over.bound, /path family .*\/l\/:id: 30 kept, 1 more/);
  assert.ok(admit(b, "https://a.test/l/3").ok, "an admitted URL stays admitted");
  for (let i = 0; i < STATE_BOUND; i++) assert.ok(admit(b, `https://a.test/cal?month=${i}`).ok);
  assert.equal(admit(b, "https://a.test/cal?month=x").ok, false);
});

test("repeat groups ignore sibling indexes", () => {
  assert.equal(repeatGroup("main > table > tbody > tr:nth-of-type(7)"), repeatGroup("main > table > tbody > tr:nth-of-type(31)"));
});

test("safety: session-enders never, money and deletion risky, form verbs clicked but recorded", () => {
  assert.equal(classify({ name: "Log out" }).verdict, "never");
  assert.equal(classify({ name: "Account", href: "https://a.test/signout" }).verdict, "never");
  assert.equal(classify({ name: "Delete listing" }).verdict, "risky");
  assert.equal(classify({ name: "Upgrade plan" }).verdict, "risky");
  assert.equal(classify({ name: "Save" }).verdict, "write-verb");
  assert.equal(classify({ name: "Calendar" }).verdict, "ok");
});

test("writes: non-read methods abort unless allowed or a GraphQL query", () => {
  assert.equal(isWrite({ method: "GET", url: "https://a.test/api" }), false);
  assert.equal(isWrite({ method: "POST", url: "https://a.test/api/save" }), true);
  assert.equal(isWrite({ method: "POST", url: "https://a.test/api/search" }, [/\/search$/]), false);
  assert.equal(isWrite({ method: "POST", url: "https://a.test/graphql", postData: '{"query":"query X { a }"}' }), false);
  assert.equal(isWrite({ method: "POST", url: "https://a.test/graphql", postData: '{"query":"mutation M { a }"}' }), true);
});

const HDR = ["header", "header/nav", "header/nav/a"];
const LIST = ["main/table", "main/table/tr", "main/table/tr/td"];
const DETAIL = ["main/article", "main/article/h1", "main/article/button"];
const MODAL = ["div[dialog]/h2", "div[dialog]/input", "div[dialog]/button"];

function closedGraph() {
  const g = Graph.create({ target: "https://a.test/app" });
  const home = g.addNode({ url: "https://a.test/app", signature: [...HDR, "main/h1"], entry: true, modules: [HDR, ["main/h1"]] }).node;
  const list = g.addNode({ url: "https://a.test/app/l", signature: [...HDR, ...LIST], modules: [HDR, LIST] }).node;
  const d1 = g.addNode({ url: "https://a.test/app/l/1", signature: [...HDR, ...DETAIL], modules: [HDR, DETAIL] }).node;
  const d2 = g.addNode({ url: "https://a.test/app/l/2", signature: [...HDR, ...DETAIL], modules: [HDR, DETAIL] }).node;
  const edit = g.addNode({ url: "https://a.test/app/l/1", state: "modal:Edit", kind: "modal", signature: MODAL }).node;
  const ext = g.addNode({ url: "https://b.test/help", signature: ["out-of-scope"], inScope: false }).node;
  g.addEdge({ from: home.id, to: list.id, kind: "navigation", element: { role: "link", name: "Listings" } });
  g.addEdge({ from: list.id, to: d1.id, kind: "click", element: { role: "row", name: "Unit 1" } });
  g.addEdge({ from: list.id, to: d2.id, kind: "click", element: { role: "row", name: "Unit 2" } });
  g.addEdge({ from: d1.id, to: edit.id, kind: "click", element: { role: "button", name: "Edit" } });
  g.addEdge({ from: home.id, to: ext.id, kind: "navigation", element: { role: "link", name: "Help" } });
  while (g.next()) {}
  for (const n of Object.values(g.data.nodes)) if (n.status === "expanding") g.setStatus(n.id, "closed");
  return { g, d1, d2, edit };
}

test("plan refuses an open graph", () => {
  const g = Graph.create({});
  g.addNode({ url: "https://a.test/", signature: ["x"], entry: true });
  assert.throws(() => plan(g), /graph not closed/);
});

test("build flow: shell first, a template waits for its modules, members become built together", () => {
  const { g, d1, d2 } = closedGraph();
  const st = plan(g);
  assert.equal(st.order[0], "shell");
  assert.ok(!st.order.includes(g.data.nodes[Object.keys(g.data.nodes).find((id) => g.data.nodes[id].status === "gap")].template), "out-of-scope placeholder template not built");
  const detail = st.order.find((u) => st.units[u].members.includes(d1.id));
  assert.ok(st.units[detail].members.includes(d2.id), "two detail pages are one template");

  const order = [];
  for (let u = nextUnit(st); u; u = nextUnit(st)) {
    assert.ok(u.deps.every((d) => order.includes(d)), `${u.id} handed out before its deps`);
    order.push(u.id);
    finish(g, st, u.id);
  }
  assert.equal(order.length, st.order.length);
  assert.equal(g.data.nodes[d2.id].status, "built");

  const text = packet(g, st, detail, { lessons: [{ id: "L-1", summary: "Rows open their detail page", level: "prose" }] });
  assert.match(text, /0 component files changed/);
  assert.match(text, /Rows open their detail page/);
  assert.match(text, /click row "Unit 1"/);
});

test("tree: every node once, under its cheapest parent", () => {
  const { g, edit } = closedGraph();
  const t = tree(g);
  assert.equal(t.split(edit.id).length - 1, 1);
  assert.match(t, /click "Edit" -> \*\*/);
});
