// discovery/graph.json (whole graph, rewritten atomically) + discovery/events.jsonl (append-only
// log of every mutation). A crash mid-write leaves the previous graph.json intact.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Graph } from "./graph.mjs";

export function paths(dir) {
  return { graph: join(dir, "graph.json"), events: join(dir, "events.jsonl") };
}

/** Open the build's graph (or create it) and wire every event to events.jsonl. */
export function open(dir, meta = {}) {
  const p = paths(dir);
  mkdirSync(dir, { recursive: true });
  const g = existsSync(p.graph) ? new Graph(JSON.parse(readFileSync(p.graph, "utf8"))) : Graph.create(meta);
  g.on((ev) => appendFileSync(p.events, JSON.stringify(ev) + "\n"));
  return g;
}

export function save(g, dir) {
  const p = paths(dir);
  mkdirSync(dirname(p.graph), { recursive: true });
  g.data.meta.updated = new Date().toISOString();
  const tmp = `${p.graph}.tmp`;
  writeFileSync(tmp, JSON.stringify(g, null, 1));
  renameSync(tmp, p.graph);
}

export function readEvents(dir, since = 0) {
  const p = paths(dir);
  if (!existsSync(p.events)) return [];
  return readFileSync(p.events, "utf8").split("\n").filter(Boolean).slice(since).map((l) => JSON.parse(l));
}
