// Correction ukg-sandbox/09: "every click" includes every Save click. openSaves lists the aborted
// save writes no saves-done.jsonl row closes, and the report shows them as open work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSaves } from "../verify.mjs";

const row = (key, name, kind = "write") => JSON.stringify({ key, kind, label: "Tags", url: "https://ref.example/tags", element: { role: "button", name } });

test("aborted save writes stay open until saves-done.jsonl closes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "saves-"));
  writeFileSync(join(dir, "pending-writes.jsonl"), [
    row("a1", "Save"),
    row("a1", "Save"),
    row("b2", "Submit"),
    row("c3", "Delete"),
    row("d4", "Save", "risky-name"),
    row("e5", "Apply"),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "saves-done.jsonl"), JSON.stringify({ key: "e5", undo: "deleted own tag", capture: "tags/e5" }) + "\n");
  const open = openSaves([dir]);
  assert.deepEqual(open.map((r) => r.key), ["a1", "b2"]);
  assert.equal(open[0].name, "Save");
});

test("a dir with no pending writes has no open saves", () => {
  assert.deepEqual(openSaves([mkdtempSync(join(tmpdir(), "saves-"))]), []);
});
