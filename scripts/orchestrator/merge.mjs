// `O merge --into <dir> --from <dir>...`: fold parallel walks of one app back into one graph.
//
// The graph store takes one writer, so a walk runs in parallel as several dir copies, one per
// worker (`--only-prefix /area`), each walking its own part. Node and edge ids are content hashes
// (nodeId, edgeId), so the same screen has the same id in every copy, and merging is a union:
//   nodes      the copy that got furthest wins (verified > built > closed > bounded > gap > frontier);
//              on a tie the target keeps its own. That node's capture folder (nodes/<id>/) is
//              copied from the copy it came from.
//   edges      union; templates and modules union; the target's meta and shell stay.
//   *.jsonl    errors, pending-writes and allowed-posts: lines a copy added are appended once.
// The target must not have a walk running (walk-lock); copies are read only.

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Graph } from "./graph.mjs";

const RANK = { verified: 6, built: 5, closed: 4, bounded: 3, gap: 2, frontier: 1, expanding: 1 };
const LOGS = ["errors.jsonl", "pending-writes.jsonl", "allowed-posts.jsonl"];

/** Merge graph data objects: `into` is changed in place. Returns ids taken from each source. */
export function mergeData(into, sources) {
  const taken = sources.map(() => []);
  sources.forEach((src, i) => {
    for (const [id, n] of Object.entries(src.nodes)) {
      const have = into.nodes[id];
      if (!have || (RANK[n.status] ?? 0) > (RANK[have.status] ?? 0)) {
        into.nodes[id] = n;
        taken[i].push(id);
      }
    }
    for (const [id, e] of Object.entries(src.edges)) into.edges[id] ??= e;
    for (const key of ["templates", "modules"]) for (const [id, t] of Object.entries(src[key] ?? {})) (into[key] ??= {})[id] ??= t;
    into.shell ??= src.shell;
  });
  return taken;
}

function appendNew(target, source) {
  if (!existsSync(source)) return 0;
  const have = new Set(existsSync(target) ? readFileSync(target, "utf8").split("\n").filter(Boolean) : []);
  const add = readFileSync(source, "utf8").split("\n").filter((l) => l && !have.has(l));
  if (add.length) writeFileSync(target, [...have, ...add].join("\n") + "\n");
  return add.length;
}

/** Merge dirs on disk. Returns counts for the log line. */
export function mergeDirs(intoDir, fromDirs) {
  const read = (d) => JSON.parse(readFileSync(join(d, "graph.json"), "utf8"));
  const into = read(intoDir);
  const sources = fromDirs.map(read);
  const taken = mergeData(into, sources);
  let folders = 0;
  taken.forEach((ids, i) => {
    for (const id of ids) {
      const src = join(fromDirs[i], "nodes", id);
      if (!existsSync(src)) continue;
      const dst = join(intoDir, "nodes", id);
      rmSync(dst, { recursive: true, force: true });
      cpSync(src, dst, { recursive: true });
      folders++;
    }
  });
  let lines = 0;
  for (const d of fromDirs) for (const f of LOGS) lines += appendNew(join(intoDir, f), join(d, f));
  into.meta.updated = new Date().toISOString();
  const g = new Graph(into); // re-reads the frontier from the merged statuses
  const tmp = join(intoDir, "graph.json.tmp");
  writeFileSync(tmp, JSON.stringify(g, null, 1));
  cpSync(tmp, join(intoDir, "graph.json"));
  rmSync(tmp);
  return { nodes: taken.reduce((a, t) => a + t.length, 0), folders, lines, frontier: g.frontier.size, total: Object.keys(into.nodes).length };
}

/** A light worker copy: the graph and logs, no capture folders (the walk writes its own). */
export function workerCopy(fromDir, toDir) {
  rmSync(toDir, { recursive: true, force: true });
  cpSync(fromDir, toDir, { recursive: true, filter: (p) => !p.startsWith(join(fromDir, "nodes") + "/") && !/\/(supervise\.pid|walk\.lock)$/.test(p) });
  return readdirSync(toDir).length;
}
