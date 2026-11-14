// frame_diff must pass a clone identical to its frame and fail each planted defect on its
// own channel: a missing label (text), a 12 px shift (layout), an extra column (structure).
// Runs the script's --selftest as the eval runner runs it (needs RL_REPO with playwright and
// tesseract on PATH).

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.env.RL_REPO || process.cwd();
if (process.env.SEEMLY_REQUIRE_BROWSER) createRequire(join(repo, "package.json")).resolve("playwright");
let skip = false;
try {
  createRequire(join(repo, "package.json")).resolve("playwright");
  execFileSync("tesseract", ["--version"], { stdio: "ignore" });
} catch {
  skip = "playwright (from RL_REPO) or tesseract missing";
}

test("frame_diff: clean passes, each planted defect fails on its channel", { skip }, () => {
  const r = spawnSync("node", [join(here, "..", "frame_diff.mjs"), "--selftest"], { encoding: "utf8", env: process.env });
  const out = r.stdout + r.stderr;
  assert.match(out, /clean\s+pass\s+pass\s+pass/);
  assert.match(out, /missing label\s+FAIL\s+pass\s+pass/);
  assert.match(out, /12 px shift\s+pass\s+FAIL\s+pass/);
  assert.match(out, /extra column\s+pass\s+pass\s+FAIL/);
  assert.equal(r.status, 0, out);
});

// The selftest above once passed every channel vacuously: the 2x OCR read never saw the
// planted words, so there was nothing to compare and an empty comparison passed. These guard
// that without tesseract or a browser.
import { layoutChannel, mergeReads, ocr, textChannel } from "../frame_diff.mjs";

const word = (text, x, y, conf = 95) => ({ text, conf, x, y, w: 60, h: 20 });

test("frame_diff: a frame with no label read fails text, never passes empty", () => {
  const r = textChannel([], [word("Approve", 10, 10)]);
  assert.equal(r.pass, false);
  assert.match(r.error, /no label read/);
});

test("frame_diff: a declared region with no matched word fails layout", () => {
  const fw = [word("Totals", 20, 400), word("Accruals", 120, 400)];
  const r = layoutChannel(fw, fw, [{ name: "toolbar", box: [0, 60, 1280, 76], kind: "region" }], {});
  assert.equal(r.pass, false);
  assert.equal(r.regions.find((g) => g.name === "toolbar").unmeasured, true);
  assert.equal(layoutChannel([], [], [], {}).pass, false, "nothing matched must not pass");
});

test("frame_diff: reads merge, keeping the confident word where two overlap", () => {
  const native = [word("Approve", 62, 90, 96), word("Totals", 24, 400, 96)];
  const big = [word("eros", 60, 92, 36), word("Morning", 194, 200, 90)];
  assert.deepEqual(mergeReads(native, big).map((w) => w.text).sort(), ["Approve", "Morning", "Totals"]);
});

test("frame_diff: missing tesseract is a loud error, not an empty read", () => {
  const PATH = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.throws(() => ocr(join(here, "frame_diff.test.mjs"), 1), /tesseract is not on PATH/);
  } finally {
    process.env.PATH = PATH;
  }
});
