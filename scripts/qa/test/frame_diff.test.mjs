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
