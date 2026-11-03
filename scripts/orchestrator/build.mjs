// The build phase (orchestrator step 4). The closed graph's build order becomes units:
// `shell`, each module archetype, each template. One unit is handed out at a time, only once
// everything it depends on is built, as a work packet: what to build, from which capture, which
// nodes are only configuration rows of it, what each control must open, how to replay each
// state, and the lessons that apply. State lives in discovery/build.json so a resume continues.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UNIT_STATUSES = ["pending", "building", "built", "verified"];
const DONE = new Set(["built", "verified"]);
const PLACEHOLDER = new Set(["out-of-scope", "bounded"]);

export function loadState(dir) {
  const p = join(dir, "build.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { order: [], units: {} };
}

export function saveState(dir, state) {
  const p = join(dir, "build.json");
  writeFileSync(`${p}.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${p}.tmp`, p);
}

/** A template every member of which is a placeholder (out of scope, bounded) is not built. */
function placeholder(g, t) {
  return t.members.every((id) => {
    const n = g.data.nodes[id];
    return n.status === "gap" || n.status === "bounded" || (n.signature.length === 1 && PLACEHOLDER.has(n.signature[0]));
  });
}

/**
 * Units in build order with their dependencies, keeping the status of any unit already in
 * `prev`. Refuses while the graph is still open: building from a half-walked graph is how a
 * template gets built twice.
 */
export function plan(g, prev = { units: {} }, { allowOpen = false } = {}) {
  if (!allowOpen && !g.isClosed()) throw new Error(`graph not closed: ${g.frontier.size} node(s) on the frontier; finish explore first (or --allow-open)`);
  const shell = new Set(g.shell());
  const skip = new Set(Object.values(g.data.templates).filter((t) => placeholder(g, t)).map((t) => t.id));
  const usedModules = new Set();
  for (const t of Object.values(g.data.templates)) {
    if (skip.has(t.id)) continue;
    for (const id of t.members) for (const m of g.data.nodes[id].modules) if (!shell.has(m)) usedModules.add(m);
  }
  const order = g.buildOrder().filter((u) => u === "shell" || (u.startsWith("t") ? !skip.has(u) : usedModules.has(u)));
  const units = {};
  for (const u of order) {
    const kind = u === "shell" ? "shell" : u.startsWith("m") ? "module" : "template";
    let deps = [];
    let members = [];
    if (kind === "module") deps = ["shell"];
    if (kind === "template") {
      members = g.data.templates[u].members.filter((id) => !["gap", "bounded"].includes(g.data.nodes[id].status));
      const mods = new Set(members.flatMap((id) => g.data.nodes[id].modules).filter((m) => !shell.has(m)));
      deps = ["shell", ...[...mods].filter((m) => order.includes(m))];
    }
    if (kind === "shell") members = [...shell];
    units[u] = { id: u, kind, deps, members, status: prev.units?.[u]?.status ?? "pending", started: prev.units?.[u]?.started ?? null, finished: prev.units?.[u]?.finished ?? null };
  }
  return { order, units, skipped: [...skip], planned: new Date().toISOString() };
}

/** The next unit whose dependencies are all built, marked `building`; a unit already building comes back first. */
export function nextUnit(state) {
  const building = state.order.find((u) => state.units[u].status === "building");
  if (building) return state.units[building];
  for (const u of state.order) {
    const unit = state.units[u];
    if (unit.status !== "pending") continue;
    if (!unit.deps.every((d) => DONE.has(state.units[d]?.status))) continue;
    unit.status = "building";
    unit.started = new Date().toISOString();
    return unit;
  }
  return null;
}

/** Mark a unit built (or verified) and its template's member nodes with it. */
export function finish(g, state, id, { verified = false } = {}) {
  const unit = state.units[id];
  if (!unit) throw new Error(`unknown unit ${id}`);
  const missing = unit.deps.filter((d) => !DONE.has(state.units[d]?.status));
  if (missing.length) throw new Error(`${id} depends on unbuilt ${missing.join(", ")}`);
  unit.status = verified ? "verified" : "built";
  unit.finished = new Date().toISOString();
  if (unit.kind === "template") for (const m of unit.members) if (["closed", "built"].includes(g.data.nodes[m].status)) g.setStatus(m, verified ? "verified" : "built");
  return unit;
}

export function progress(state) {
  const by = Object.fromEntries(UNIT_STATUSES.map((s) => [s, 0]));
  for (const u of Object.values(state.units)) by[u.status]++;
  return { units: state.order.length, ...by };
}

function routeText(g, id) {
  const path = g.route(id);
  if (path === null) return "unreachable without a write (see pending-writes.jsonl)";
  if (!path.length) return `open ${g.data.nodes[id].url}`;
  return [`open ${g.data.nodes[path[0].from].url}`, ...path.map((e) => `${e.kind} ${e.element.role ?? ""} "${e.element.name ?? e.element.css}"`)].join(" -> ");
}

/**
 * The work packet for one unit, as markdown. `lessons` is the learning store's `select` for
 * this unit's phase and kind; `pending` the pending-writes rows on its nodes.
 */
export function packet(g, state, id, { lessons = [], pending = [], skill = "<skill>" } = {}) {
  const unit = state.units[id];
  if (!unit) throw new Error(`unknown unit ${id}`);
  const L = [];
  const node = (nid) => g.data.nodes[nid];
  L.push(`# Work packet ${id} (${unit.kind})`, "");
  L.push(`Status: ${unit.status}. Depends on: ${unit.deps.join(", ") || "nothing"}.`, "");

  if (unit.kind === "shell" || unit.kind === "module") {
    const users = Object.values(g.data.nodes).filter((n) => n.modules.some((m) => (unit.kind === "shell" ? unit.members.includes(m) : m === id)));
    L.push(unit.kind === "shell"
      ? `The shared layout: module archetypes ${unit.members.join(", ") || "(none yet: fewer than two pages)"} appear on every in-scope page. Build them once as the layout every route renders inside.`
      : `One module archetype, used ${g.data.modules[id].uses} time(s). One component; each placement is a params row, never a branch on the page.`, "");
    L.push("## Where it appears", "", "| node | kind | url | artifacts |", "|---|---|---|---|");
    for (const n of users.slice(0, 25)) L.push(`| ${n.id} | ${n.kind} | ${n.url}${n.state ? ` [${n.state}]` : ""} | ${n.info?.artifacts ?? "not captured"} |`);
    if (users.length > 25) L.push(`| ... | | ${users.length - 25} more | |`);
    L.push("");
  }

  if (unit.kind === "template") {
    const members = unit.members.map(node);
    const rep = members.find((n) => n.info?.artifacts) ?? members[0];
    L.push(`One component for ${members.length} node(s). Build it from **${rep.id}** (${rep.label}); every other member is configuration rows (data, params), with **0 component files changed**.`, "");
    L.push("## Members", "", "| node | kind | url / state | status | artifacts |", "|---|---|---|---|---|");
    for (const n of members) L.push(`| ${n.id}${n.id === rep.id ? " (build from)" : ""} | ${n.kind} | ${n.url}${n.state ? ` [${n.state}]` : ""} | ${n.status} | ${n.info?.artifacts ?? "not captured"} |`);
    L.push("");
    L.push("Each artifacts dir holds `screenshot.png`, `dom.html`, `aria.yml` (the accessibility tree to match), `inventory.json` (every element and what it did) and `xhr/` (the JSON the page read: the seed and the response shapes).", "");
    L.push("## What every control must do", "", "| from | element | kind | opens |", "|---|---|---|---|");
    const memberSet = new Set(unit.members);
    for (const e of Object.values(g.data.edges).filter((e) => memberSet.has(e.from))) {
      const to = node(e.to);
      const where = to.status === "gap" ? "out of scope: real href to the standard out-of-scope page" : to.status === "bounded" ? `bounded (${to.bound})` : `${to.label} (${to.id}, template ${to.template})`;
      L.push(`| ${e.from} | ${e.element.role ?? ""} "${(e.element.name ?? "").slice(0, 50)}" | ${e.kind} | ${where} |`);
    }
    L.push("");
    L.push("## Replay routes (golden traces start here)", "");
    for (const n of members) L.push(`- ${n.id}: ${routeText(g, n.id)}`);
    L.push("");
  }

  if (pending.length) {
    L.push("## Writes on these nodes (BLOCKED before firing on the reference; build each with its round trip)", "");
    for (const p of pending) L.push(`- ${p.node} ${p.element.role} "${p.element.name}": ${p.why}${p.blocked?.length ? `; aborted ${p.blocked.map((b) => `${b.method} ${new URL(b.url).pathname}`).join(", ")}` : ""}`);
    L.push("");
  }

  L.push("## Lessons that apply", "");
  if (lessons.length) for (const l of lessons) L.push(`- ${l.summary} (${l.id}${l.level === "checklist" ? ", checklist: tick it" : ""})`);
  else L.push("- none selected from the lesson store; reference/*.md still applies");
  L.push("");
  L.push("## Procedure (SKILL.md section 5, none skipped)", "");
  L.push(
    "1. Anatomy from the capture. 2. Semantic skeleton. 3. Schema and backend (Pydantic first, OpenAPI metadata, writes W1-W6). 4. Wire through `/api`. 5. All eight states. 6. Computed-style convergence to zero. 7. Mount it. 8. Wire every write with its round trip. 9. Human-eye pass.",
    "",
    "Verify before calling it built:",
    "",
    "```bash",
    `node ${skill}/scripts/qa/struct_audit.mjs --ref <ref url> --clone <clone url>`,
    `node ${skill}/scripts/qa/human_eye.mjs --url <clone url>`,
    `node ${skill}/scripts/qa/write_roundtrip.mjs --spec never_to_be_pushed/discovery/writes/${id}.json   # if it writes`,
    "```",
    "",
    `Then: \`node ${skill}/scripts/orchestrator/run.mjs unit-done ${id}\` (add \`--verified\` once PAGE COMPLETE / MODAL COMPLETE pass).`,
  );
  return L.join("\n") + "\n";
}

export function writePacket(dir, id, text) {
  mkdirSync(join(dir, "packets"), { recursive: true });
  const p = join(dir, "packets", `${id}.md`);
  writeFileSync(p, text);
  return p;
}
