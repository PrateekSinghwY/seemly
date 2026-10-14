// The lesson store: every thing seemly learned, as structured rows instead of prose.
// One JSON object per line in a .jsonl file; small enough to rewrite whole, atomically.
//
// A lesson climbs a ladder each time its defect comes back after it was recorded:
//   prose -> checklist -> gate -> code
// Prose and checklists must be read to work; gates and code enforce themselves. So the
// goal of the ladder is that recurring lessons stop needing to be read at all.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const LEVELS = ["prose", "checklist", "gate", "code"];
export const TRIGGERS = ["verify-failure", "rounds", "gate-catch", "correction", "assumption", "near-miss", "post-build-fix"];
export const STATUSES = ["candidate", "active", "rejected", "retired"];
/** A lesson seen in this many distinct builds is ready to promote into the shared skill. */
export const PROMOTE_AT = 3;
/** Token overlap at or above which two summaries are the same lesson. */
export const SAME_LESSON = 0.6;

const STOP = new Set("a an and are as at be but by for from has have in into is it its of on or that the then this to was were when where which while with not no never every each".split(" "));

export function tokens(text) {
  return [...new Set(
    text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s|e)$/, "")),
  )];
}

function overlap(a, b) {
  const sa = new Set(a);
  const inter = b.filter((x) => sa.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

export class LessonStore {
  constructor(path) {
    this.path = path;
    this.rows = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.rows.map((r) => JSON.stringify(r)).join("\n") + (this.rows.length ? "\n" : ""));
    renameSync(tmp, this.path);
  }

  get(id) {
    return this.rows.find((r) => r.id === id);
  }

  /** The existing lesson this one duplicates: same phase, summaries overlapping >= SAME_LESSON. */
  match({ summary, tags = {} }) {
    const t = tokens(summary);
    let best = null;
    let score = 0;
    for (const r of this.rows) {
      if (r.status === "rejected") continue;
      if (tags.phase && r.tags.phase && !intersects(tags.phase, r.tags.phase)) continue;
      const s = overlap(t, r.tokens);
      if (s > score) [best, score] = [r, s];
    }
    return score >= SAME_LESSON ? best : null;
  }

  /**
   * Record one occurrence. A new lesson starts as a `candidate` at `prose`; a duplicate gets
   * another `seen` row instead. A lesson that would lower a bar (`weakens`) is stored
   * `rejected` and never applied, per distill.md "Never weaken".
   *
   * Returns `{ lesson, isNew, recurred }`. `recurred` = the defect came back in a later build
   * than the one that set its current level: the lesson as written did not prevent it.
   */
  record({ summary, trigger, tags = {}, build, evidence = "", weakens = false, at = new Date().toISOString() }) {
    if (!TRIGGERS.includes(trigger)) throw new Error(`bad trigger ${trigger}`);
    if (!build) throw new Error("build is required: a lesson without its origin cannot be cited");
    const norm = normTags(tags);
    const seen = { build, at, trigger, evidence };
    const dup = weakens ? null : this.match({ summary, tags: norm });
    if (dup) {
      const recurred = dup.levelSince.build !== build && !dup.seen.some((s) => s.build === build) && dup.status === "active";
      dup.seen.push(seen);
      for (const k of Object.keys(norm)) dup.tags[k] = [...new Set([...(dup.tags[k] ?? []), ...norm[k]])];
      if (recurred) dup.recurrences.push({ build, at, level: dup.level });
      return { lesson: dup, isNew: false, recurred };
    }
    const lesson = {
      id: "L-" + createHash("sha1").update(tokens(summary).join(" ")).digest("hex").slice(0, 8),
      summary,
      tokens: tokens(summary),
      tags: norm,
      level: "prose",
      levelSince: { build, at },
      status: weakens ? "rejected" : "candidate",
      check: null,
      eval: null,
      seen: [seen],
      recurrences: [],
      note: weakens ? "not applied: would weaken a gate" : "",
    };
    this.rows.push(lesson);
    return { lesson, isNew: true, recurred: false };
  }

  activate(id) {
    const l = this.#must(id);
    if (l.status === "rejected") throw new Error(`${id} is rejected (would weaken a gate)`);
    l.status = "active";
    return l;
  }

  /**
   * Move a lesson one or more rungs up. A gate or code rung must name the check that now
   * enforces it and the eval case that proves the check fails without the fix
   * (distill.md: "A check that was never seen failing is not wired").
   */
  escalate(id, { to, check, evalId, build, at = new Date().toISOString() }) {
    const l = this.#must(id);
    const from = LEVELS.indexOf(l.level);
    const target = to ? LEVELS.indexOf(to) : from + 1;
    if (target <= from || target >= LEVELS.length) throw new Error(`cannot move ${id} from ${l.level} to ${to ?? "next"}`);
    if (LEVELS[target] === "gate" || LEVELS[target] === "code") {
      if (!check) throw new Error(`${LEVELS[target]} needs the check that enforces it`);
      if (!evalId) throw new Error(`${LEVELS[target]} needs an eval case that fails without the fix`);
    }
    l.level = LEVELS[target];
    l.levelSince = { build: build ?? l.levelSince.build, at };
    if (check) l.check = check;
    if (evalId) l.eval = evalId;
    return l;
  }

  /**
   * The lessons a worker must read for one node: active, still prose or checklist (gates and
   * code run on their own), sharing at least one tag with the context. Ranked by tag
   * matches, then recurrences (lessons that already failed once matter more), then how
   * often seen. A worker reads a short relevant list instead of the whole reference.
   */
  select({ phase, kind, area, tool } = {}, limit = 20) {
    const ctx = { phase, kind, area, tool };
    const weight = { phase: 3, kind: 2, area: 2, tool: 1 };
    return this.rows
      .filter((r) => r.status === "active" && (r.level === "prose" || r.level === "checklist"))
      .map((r) => {
        let s = 0;
        for (const [k, w] of Object.entries(weight)) {
          const want = ctx[k];
          const have = r.tags[k];
          if (!want || !have?.length) continue;
          if (have.includes("any") || have.includes(want)) s += w;
        }
        return { r, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.r.recurrences.length - a.r.recurrences.length || b.r.seen.length - a.r.seen.length || (a.r.id < b.r.id ? -1 : 1))
      .slice(0, limit)
      .map((x) => x.r);
  }

  /**
   * What needs a human or distill decision:
   * - promote: candidates seen in >= PROMOTE_AT builds
   * - escalate: active lessons whose defect recurred at their current level
   * - stale: active prose lessons not seen in the last `staleAfter` builds (review, not delete)
   */
  review(builds = [], staleAfter = 5) {
    const distinct = (l) => new Set(l.seen.map((s) => s.build)).size;
    const recent = new Set(builds.slice(-staleAfter));
    return {
      promote: this.rows.filter((l) => l.status === "candidate" && distinct(l) >= PROMOTE_AT),
      escalate: this.rows.filter((l) => l.status === "active" && l.recurrences.some((r) => r.level === l.level)),
      stale: builds.length >= staleAfter ? this.rows.filter((l) => l.status === "active" && l.level === "prose" && !l.seen.some((s) => recent.has(s.build))) : [],
    };
  }

  retire(id, reason) {
    const l = this.#must(id);
    l.status = "retired";
    l.note = reason;
    return l;
  }

  /** Fold another store (a build's local inbox) into this one, deduping as `record` does. */
  merge(other) {
    const out = { added: 0, merged: 0 };
    for (const r of other.rows) {
      for (const s of r.seen) {
        const res = this.record({ summary: r.summary, trigger: s.trigger, tags: r.tags, build: s.build, evidence: s.evidence, weakens: r.status === "rejected", at: s.at });
        res.isNew ? out.added++ : out.merged++;
      }
    }
    return out;
  }

  #must(id) {
    const l = this.get(id);
    if (!l) throw new Error(`unknown lesson ${id}`);
    return l;
  }
}

function normTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    const list = (Array.isArray(v) ? v : [v]).filter(Boolean).map((x) => String(x).toLowerCase());
    if (list.length) out[k] = [...new Set(list)];
  }
  return out;
}

function intersects(a, b) {
  return a.some((x) => b.includes(x) || x === "any") || b.includes("any");
}
