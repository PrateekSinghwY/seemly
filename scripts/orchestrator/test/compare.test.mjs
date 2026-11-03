import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { compare, norm, toMarkdown, viewKey } from "../compare.mjs";

/** A walk on disk: graph.json plus one inventory per node. */
function walk(origin, pages) {
  const dir = mkdtempSync(join(tmpdir(), "cmp-"));
  const nodes = {};
  pages.forEach((p, i) => {
    const id = `n_${i}`;
    nodes[id] = { id, url: origin + p.path, href: origin + p.path, kind: p.kind ?? "page", state: p.state ?? "", status: "closed", info: { artifacts: `nodes/${id}` } };
    mkdirSync(join(dir, "nodes", id), { recursive: true });
    writeFileSync(join(dir, "nodes", id, "inventory.json"), JSON.stringify({ candidates: p.controls ?? [] }));
  });
  writeFileSync(join(dir, "graph.json"), JSON.stringify({ nodes, edges: {}, templates: {}, modules: {}, meta: {} }));
  return dir;
}

const shell = [{ role: "button", name: "Account", outcome: "overlay", children: ["x"] }];

test("view keys: ids collapse, view flags kept, data params dropped", () => {
  assert.equal(viewKey("https://a.test/listings/123?open_calendar=true&listing=9"), "/listings/:id?open_calendar");
  assert.equal(norm(" Showing 4/18  Listings "), "showing #/# listings");
});

test("compare: missing, disabled-only-on-clone, dead, never-opened, missing view; shell compared once", () => {
  const ref = walk("https://ref.test", [
    { path: "/a", controls: [...shell, { role: "button", name: "Export", outcome: "overlay", children: ["n_9"] }, { role: "button", name: "Bulk Update", outcome: "overlay", children: ["n_8"] }, { role: "button", name: "Archive", outcome: "inert" }] },
    { path: "/a", kind: "modal", state: "modal:Email Preferences" },
    { path: "/b", controls: shell },
    { path: "/c", controls: shell },
    { path: "/only-ref", controls: shell },
  ]);
  const clone = walk("http://clone.test", [
    { path: "/a", controls: [{ role: "button", name: "Account", outcome: "shell: expanded on 2 templates" }, { role: "button", name: "Export", outcome: "inert" }, { role: "button", name: "Bulk Update", outcome: "disabled" }] },
    { path: "/b", controls: [] },
    { path: "/c", controls: [] },
  ]);
  const r = compare(ref, clone);
  assert.deepEqual(r.pagesMissing.map((p) => p.key), ["/only-ref"]);
  const a = r.pages.find((p) => p.key === "/a");
  assert.deepEqual(a.missing, ["Archive"]);
  assert.deepEqual(a.disabled, ["Bulk Update"]);
  assert.deepEqual(a.dead, ["Export"]);
  assert.deepEqual(a.noSurface, ["modal: Email Preferences"]);
  const b = r.pages.find((p) => p.key === "/b");
  assert.deepEqual(b.missing, [], "shell controls are not re-reported per page");
  assert.match(toMarkdown(r), /not rendered on the clone:\*\* Archive/);
});
