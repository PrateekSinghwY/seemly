// Why a node was given up on, and the corrections that put nodes back on the frontier:
// `requeue --gaps` (retryable reasons, write-only nodes whose writes were load-time reads) and
// `requeue --risky` (elements held by a name rule that no longer holds them). explore.mjs records
// the reasons; run.mjs calls the requeues.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CHOICE_ROLES, RequestClassifier, classify } from "./safety.mjs";

/** An error worth retrying the navigation for (5xx, 429, a timeout, an aborted load). */
export const TRANSIENT_ERR = /Timeout \d+ms exceeded|timed out|ERR_ABORTED|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_HTTP2|ERR_SSL_PROTOCOL|HTTP (5\d\d|429|408)\b|serviceUnavailable|service unavailable/i;

/**
 * A machine-readable reason for an explore failure: `{ code, retryable }`. Retryable gaps are
 * what `requeue --gaps` puts back on the frontier.
 */
export function failureReason(message = "") {
  const m = String(message);
  if (/^load-aborted:/.test(m)) return { code: "load-aborted", retryable: true };
  if (/^never-open:/.test(m)) return { code: "never-open", retryable: false };
  if (/^session-ending:/.test(m)) return { code: "session-ending", retryable: false };
  if (/^HTTP 40[13]\b/.test(m)) return { code: "http-auth", retryable: true };
  if (/^HTTP 4\d\d\b/.test(m)) return { code: "http-4xx", retryable: false };
  if (TRANSIENT_ERR.test(m) && !/^replay:|locator\./.test(m)) return { code: "transient", retryable: true };
  if (/^replay: .* not found/.test(m)) return { code: "replay-not-found", retryable: true };
  if (/locator\.\w+: Timeout/.test(m)) return { code: "replay-timeout", retryable: true };
  if (/^invariant:/.test(m)) return { code: "invariant", retryable: true };
  if (/unreachable without a write/.test(m)) return { code: "write-only", retryable: false };
  return { code: "error", retryable: true };
}

/** Record `id` as a gap with its reason, on the node (`gapReason`) and in its status detail. */
export function markGap(g, id, reason, message) {
  const n = g.node(id);
  n.gapReason = { ...reason, message: String(message ?? "").split("\n")[0].slice(0, 300), at: new Date().toISOString() };
  g.setStatus(id, "gap", `explore failed (${reason.code}): ${n.gapReason.message}`);
}

/**
 * The reason of any gap node, including ones written before reasons existed (an out-of-scope
 * node, a legacy "explore failed twice: ..." detail, a person's `gap --reason`).
 */
export function gapReason(n) {
  if (n.status !== "gap") return null;
  if (n.gapReason) return n.gapReason;
  if (n.signature?.[0] === "out-of-scope") return { code: "out-of-scope", retryable: false, message: n.url };
  const d = n.detail ?? "";
  const m = d.match(/^explore failed[^:]*: (.*)$/s);
  if (m) return { ...failureReason(m[1]), message: m[1] };
  return { code: "manual", retryable: false, message: d };
}

/** Gap nodes whose reason is retryable: what `requeue --gaps` puts back. */
export function retryableGaps(g) {
  return Object.values(g.data.nodes).filter((n) => gapReason(n)?.retryable).map((n) => n.id);
}

/** Put every retryable gap back on the frontier with its attempts reset. Returns the ids. */
export function requeueGaps(g) {
  const ids = retryableGaps(g);
  for (const id of ids) {
    const n = g.node(id);
    n.attempts = 0;
    delete n.gapReason;
    g.setStatus(id, "frontier", null);
  }
  return ids;
}

const back = (g, n) => {
  n.attempts = 0;
  if (n.status !== "frontier") g.setStatus(n.id, "frontier", null);
};

/**
 * Nodes closed `bounded` as "reached only through a write" (or a `load-aborted` gap) whose every
 * write edge in was a page-load read aborted by an older rule: the edge carries no request, a load-aborted mark, or a
 * request the classifier now lets through at load. Those edges are dropped, and the node and the
 * nodes they came from go back on the frontier, so the next walk records the edge as it is.
 * Returns the requeued nodes.
 */
export function requeueWriteOnly(g, { allowPost = [] } = {}) {
  const reqs = new RequestClassifier({ allowPost, readPosts: "auto", origin: g.data.meta.origin ?? null });
  const nowRead = (r) => !r?.url || reqs.classify({ method: r.method ?? "POST", url: r.url, postData: r.body ?? "", phase: "load" }).verdict !== "write";
  const out = [];
  for (const n of Object.values(g.data.nodes)) {
    const writeOnly = n.status === "bounded" && /through a write/.test(`${n.bound ?? ""} ${n.detail ?? ""}`);
    if (!writeOnly && !(n.status === "gap" && n.gapReason?.code === "load-aborted")) continue;
    const writes = Object.values(g.data.edges).filter((e) => e.to === n.id && e.kind === "write");
    if (!writes.length || !writes.every((e) => e.loadAborted || nowRead(e.request))) continue;
    for (const e of writes) {
      g.removeEdge(e.id);
      const from = g.data.nodes[e.from];
      if (from && !out.includes(from) && !["gap", "bounded"].includes(from.status)) {
        back(g, from);
        out.push(from);
      }
    }
    n.bound = null;
    delete n.gapReason;
    back(g, n);
    out.push(n);
  }
  return out;
}

/**
 * `O requeue --risky`: every node with an element skipped as risky by name that the current rule
 * would fire (its name is no longer risky, or it is a choice a picker may hold) goes back on the
 * frontier. Its template forgets what it has seen, so template sampling does not skip it, and the
 * `risky-name` rows of pending-writes.jsonl the rule no longer holds are dropped.
 * Returns `{ nodes, skipped, refire, dropped }`.
 */
export function requeueRisky(g, dir) {
  const nodes = [];
  let skipped = 0;
  let refire = 0;
  const refires = (r) => {
    const v = classify(r);
    return (v.verdict !== "risky" && v.verdict !== "never") || (v.verdict === "risky" && !/deletion or messaging/.test(v.why) && CHOICE_ROLES.has(r.role));
  };
  for (const n of Object.values(g.data.nodes)) {
    if (!n.info?.artifacts) continue;
    const p = join(dir, n.info.artifacts, "inventory.json");
    if (!existsSync(p)) continue;
    let inv;
    try {
      inv = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    const held = [...(inv.candidates ?? []), ...(inv.interactions ?? [])].filter((r) => r.unfired === "skipped:risky");
    skipped += held.length;
    const again = held.filter(refires);
    if (!again.length) continue;
    refire += again.length;
    const t = g.data.templates[n.template];
    if (t) {
      t.seenKeys = [];
      t.seenInteractions = [];
    }
    back(g, n);
    nodes.push(n);
  }
  const pendingPath = join(dir, "pending-writes.jsonl");
  let dropped = 0;
  if (existsSync(pendingPath)) {
    const lines = readFileSync(pendingPath, "utf8").split("\n").filter(Boolean);
    const keep = lines.filter((l) => {
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        return true;
      }
      const byName = r.kind === "risky-name" || (!r.kind && !r.blocked?.length && /^name reads as (money|deletion)/.test(r.why ?? ""));
      if (byName && r.element && refires(r.element)) {
        dropped++;
        return false;
      }
      return true;
    });
    if (dropped) writeFileSync(pendingPath, keep.map((l) => l + "\n").join(""));
  }
  return { nodes, skipped, refire, dropped };
}
