// Correction ukg-sandbox/10: over CDP the walker's request guard blocked a second agent's saves in
// another tab of the same window. The guard now judges only pages the walk owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OwnedPages } from "../explore.mjs";

const fakePage = () => { const h = {}; return { on: (e, f) => { h[e] = f; }, emit: (e, x) => h[e]?.(x) }; };

test("pages the walk opened and their popups are owned; other tabs are foreign", () => {
  const o = new OwnedPages();
  const mine = o.adopt(fakePage());
  const popup = fakePage();
  mine.emit("popup", popup);
  const other = fakePage();
  assert.equal(o.foreign(mine), false);
  assert.equal(o.foreign(popup), false);
  assert.equal(o.foreign(other), true);
  assert.equal(o.foreign(null), false, "a request with no page (a worker) is still judged");
});

import { wrongSession } from "../supervise.mjs";
test("a valid session without the required text is the wrong session", () => {
  assert.equal(wrongSession("Home Acting as someone Change", "Acting as"), null);
  assert.match(wrongSession("Home My time off Tile 1 of 9", "Acting as"), /does not show/);
  assert.equal(wrongSession("anything", null), null);
});
