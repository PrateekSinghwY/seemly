#!/usr/bin/env node
// Read-only views over a build's graph. Usage:
//   node cli.mjs <discovery-dir> stats | frontier | order | route <nodeId> | loops

import { open } from "./store.mjs";

const [dir, cmd = "stats", arg] = process.argv.slice(2);
if (!dir) {
  console.error("usage: cli.mjs <discovery-dir> stats|frontier|order|route <nodeId>|loops");
  process.exit(2);
}
const g = open(dir);
const label = (id) => `${id} ${g.data.nodes[id]?.label ?? ""}`.trim();

switch (cmd) {
  case "stats":
    console.log(JSON.stringify(g.stats(), null, 2));
    break;
  case "frontier":
    for (const id of g.frontierOrder()) console.log(label(id));
    break;
  case "order":
    console.log(g.buildOrder().join("\n"));
    break;
  case "route": {
    const path = g.route(arg);
    if (!path) console.log("unreachable without a write");
    else for (const e of path) console.log(`${e.kind.padEnd(10)} ${e.element.name ?? e.element.selector ?? ""}  ->  ${label(e.to)}`);
    break;
  }
  case "loops":
    for (const c of g.loops()) console.log(c.map(label).join("  <->  "));
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
