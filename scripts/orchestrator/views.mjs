// Read-only views of the graph for people: tree.md (the click tree from each entry, by the
// cheapest route, with a verdict per node) and graph.html (the live diagram, orchestrator
// step 2), both regenerated from graph.json whenever asked.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { dijkstra } from "./algorithms.mjs";

const VERDICT = { frontier: "open", expanding: "open", closed: "explored", built: "built", verified: "verified", gap: "GAP", bounded: "bounded" };

/** The shortest-route tree from the entry nodes, as indented markdown. */
export function tree(g) {
  const nodes = g.data.nodes;
  const sources = Object.values(nodes).filter((n) => n.entry).map((n) => n.id);
  const out = new Map();
  for (const e of Object.values(g.data.edges)) (out.get(e.from) ?? out.set(e.from, []).get(e.from)).push({ to: e.to, cost: e.cost, edge: e });
  const res = dijkstra(sources, (u) => out.get(u) ?? []);
  const children = new Map();
  for (const [id, e] of res.prev) (children.get(e.from) ?? children.set(e.from, []).get(e.from)).push({ id, e });
  const s = g.stats();
  const L = [
    "# Surface tree",
    "",
    `${s.nodes} nodes (${Object.entries(s.byStatus).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ")}), ${s.edges} edges, ${s.templates} templates, frontier ${s.frontier}. Closed: ${g.isClosed() ? "yes" : "no"}.`,
    "",
  ];
  const line = (n, depth, via) =>
    `${"  ".repeat(depth)}- ${via ? `${via.kind} "${(via.element.name ?? "").slice(0, 40)}" -> ` : ""}**${n.label.slice(0, 70)}** \`${n.id}\` ${n.kind}, ${n.template}, ${VERDICT[n.status]}${n.bound ? ` (${n.bound})` : ""}${n.detail ? ` (${n.detail})` : ""}`;
  const seen = new Set();
  const walk = (id, depth, via) => {
    seen.add(id);
    L.push(line(nodes[id], depth, via));
    const kids = (children.get(id) ?? []).sort((a, b) => nodes[a.id].label.localeCompare(nodes[b.id].label));
    for (const k of kids) walk(k.id, depth + 1, k.e);
  };
  for (const s0 of sources) walk(s0, 0, null);
  const rest = Object.keys(nodes).filter((id) => !seen.has(id));
  if (rest.length) {
    L.push("", "## Reachable only through a write", "");
    for (const id of rest) L.push(line(nodes[id], 0, null));
  }
  const loops = g.loops();
  if (loops.length) L.push("", `## Loops (${loops.length})`, "", ...loops.map((c) => `- ${c.length} surfaces: ${c.slice(0, 8).map((id) => nodes[id].label.slice(0, 30)).join(" <-> ")}${c.length > 8 ? " <-> ..." : ""}`));
  return L.join("\n") + "\n";
}

export function writeTree(g, dir) {
  const p = join(dir, "tree.md");
  writeFileSync(p, tree(g));
  return p;
}

/**
 * graph.html: one self-contained page drawing the graph. Nodes coloured by status, shaped by
 * kind; write edges dashed red. Opened as a file it re-reads itself every 15 s.
 */
export function writeLive(g, dir, { refresh = 15 } = {}) {
  const els = [
    ...Object.values(g.data.nodes).map((n) => ({ data: { id: n.id, label: n.label.slice(0, 32), status: n.status, kind: n.kind, template: n.template } })),
    ...Object.values(g.data.edges).map((e) => ({ data: { id: e.id, source: e.from, target: e.to, kind: e.kind } })),
  ];
  const s = g.stats();
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}">
<title>Surface graph</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#d9d6cf}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a3a29b;--line:#3a3935}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:16px;flex-wrap:wrap;align-items:baseline}
header h1{font-size:16px;margin:0}header span{color:var(--muted)}
#cy{position:absolute;top:56px;left:0;right:0;bottom:0}
.k{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:middle}
</style></head><body>
<header><h1>Surface graph</h1>
<span>${s.nodes} nodes · ${s.edges} edges · ${s.templates} templates · frontier ${s.frontier} · ${g.isClosed() ? "closed" : "open"}</span>
<span><i class="k" style="background:#9a9790"></i>open <i class="k" style="background:#3b82c4"></i>explored <i class="k" style="background:#2f9e5b"></i>built/verified <i class="k" style="background:#c98a1b"></i>bounded <i class="k" style="background:#c0473a"></i>gap</span></header>
<div id="cy" role="img" aria-label="Directed graph of every surface and the interactions between them"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script>
const els=${JSON.stringify(els)};
const C={frontier:"#9a9790",expanding:"#9a9790",closed:"#3b82c4",built:"#2f9e5b",verified:"#2f9e5b",bounded:"#c98a1b",gap:"#c0473a"};
const S={page:"round-rectangle",modal:"diamond",menu:"triangle",overlay:"hexagon",state:"ellipse",tooltip:"vee"};
const dark=matchMedia("(prefers-color-scheme: dark)").matches;
cytoscape({container:document.getElementById("cy"),elements:els,wheelSensitivity:0.3,
 layout:{name:"breadthfirst",directed:true,spacingFactor:1.1,roots:els.filter(e=>!e.data.source&&${JSON.stringify(Object.values(g.data.nodes).filter((n) => n.entry).map((n) => n.id))}.includes(e.data.id)).map(e=>"#"+e.data.id)},
 style:[{selector:"node",style:{"background-color":e=>C[e.data("status")]||"#999",shape:e=>S[e.data("kind")]||"ellipse",label:"data(label)","font-size":9,color:dark?"#ecebe6":"#1d1d1b","text-valign":"bottom","text-margin-y":3,width:18,height:18}},
  {selector:"edge",style:{width:1,"line-color":dark?"#55534d":"#c9c6be","target-arrow-shape":"triangle","target-arrow-color":dark?"#55534d":"#c9c6be","curve-style":"bezier","arrow-scale":0.6}},
  {selector:'edge[kind="write"]',style:{"line-color":"#c0473a","target-arrow-color":"#c0473a","line-style":"dashed"}},
  {selector:'edge[kind="hover"]',style:{"line-style":"dotted"}}]});
</script></body></html>
`;
  const p = join(dir, "graph.html");
  writeFileSync(p, html);
  return p;
}
