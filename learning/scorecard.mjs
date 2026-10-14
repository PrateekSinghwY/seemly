// Per-build numbers, so "the skill got better" is measured instead of felt.
// One row per build in a .jsonl file. Every metric here is a count where lower is better.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const METRICS = {
  corrections: "messages the human had to type mid-run",
  correctionsPerNode: "corrections / nodes closed",
  roundsAvg: "mean step-8 convergence rounds per component",
  gateCatches: "defects a gate caught before the human saw them (informational: higher = gates earning their keep)",
  postBuildFixes: "fix items found after DONE (bug sheets, QA, review)",
  humanTurns: "every human message after go, including STATUS",
};
/** Metrics where a rise is good news, so trend() does not flag them. */
const HIGHER_IS_FINE = new Set(["gateCatches"]);

export function read(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export function add(path, { build, metrics, at = new Date().toISOString() }) {
  for (const k of Object.keys(metrics)) if (!(k in METRICS)) throw new Error(`unknown metric ${k}; known: ${Object.keys(METRICS).join(", ")}`);
  const row = { build, at, metrics };
  appendFileSync(path, JSON.stringify(row) + "\n");
  return row;
}

/**
 * Latest build against the mean of the builds before it, per metric. `worse` marks a metric
 * that moved the wrong way by more than `tolerance` (fraction of the earlier mean).
 */
export function trend(rows, tolerance = 0.1) {
  if (rows.length < 2) return [];
  const last = rows.at(-1);
  const before = rows.slice(0, -1);
  return Object.keys(last.metrics).map((k) => {
    const prev = before.map((r) => r.metrics[k]).filter((v) => typeof v === "number");
    if (!prev.length) return { metric: k, latest: last.metrics[k], mean: null, worse: false };
    const mean = prev.reduce((a, b) => a + b, 0) / prev.length;
    const delta = last.metrics[k] - mean;
    const worse = !HIGHER_IS_FINE.has(k) && delta > Math.max(tolerance * Math.abs(mean), 1e-9);
    return { metric: k, latest: last.metrics[k], mean: +mean.toFixed(3), worse };
  });
}
