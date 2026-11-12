#!/usr/bin/env node
// The coordinator. SKILL.md sections 4-5 drive the build through these commands; the graph
// decides what is next, never the builder. Run from the clone repo's root (or set RL_REPO).
//
//   explore phase
//     init --target <url> [--prefix /path]... [--entry <url>]...  create the graph from entry pages
//     explore [--max-nodes N] [--risky record|probe] [--allow-post <regex>]... [--read-posts off|auto]
//             [--pace <ms>] [--relogin-wait <minutes>] [--sample K] [--only-prefix /area]...
//     visit <url>                                                  add one more entry page
//     requeue <nodeId> | requeue --failed | gap <nodeId> --reason "..."   corrections; --failed restores give-ups
//     pending                                                      writes waiting for BLOCKED
//   build phase
//     plan [--allow-open]                                          units in dependency order
//     next-unit                                                    claim the next unit, write its packet
//     packet <unit>                                                rewrite one unit's packet
//     unit-done <unit> [--verified]
//   views
//     status | tree | live | frontier | route <nodeId> | loops
//     compare --ref <dir>... --clone <dir>... [--out diff.md]       reference walk vs clone walk
//   (any) --dir <discovery dir>   --cdp <http://127.0.0.1:9222>   --headed

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DISCOVERY } from "../lib/pw.mjs";
import { finish, loadState, nextUnit, packet, plan, progress, saveState, writePacket } from "./build.mjs";
import { compare, toMarkdown } from "./compare.mjs";
import { SessionLost, explore, readEntry } from "./explore.mjs";
import { open, save } from "./store.mjs";
import { writeLive, writeTree } from "./views.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = dirname(dirname(here));
const argv = process.argv.slice(2);
const cmd = argv[0];
const { values: o, positionals } = parseArgs({
  args: argv.slice(1),
  allowPositionals: true,
  options: {
    dir: { type: "string", default: DISCOVERY },
    target: { type: "string" },
    prefix: { type: "string", multiple: true },
    entry: { type: "string", multiple: true, default: [] },
    "max-nodes": { type: "string" },
    risky: { type: "string", default: "record" },
    "allow-post": { type: "string", multiple: true, default: [] },
    "read-posts": { type: "string", default: "off" },
    pace: { type: "string" },
    "relogin-wait": { type: "string" },
    sample: { type: "string" },
    cdp: { type: "string" },
    headed: { type: "boolean", default: false },
    reason: { type: "string" },
    verified: { type: "boolean", default: false },
    "allow-open": { type: "boolean", default: false },
    failed: { type: "boolean", default: false },
    "only-prefix": { type: "string", multiple: true },
    ref: { type: "string", multiple: true },
    clone: { type: "string", multiple: true },
    out: { type: "string" },
  },
});
const dir = o.dir;
const browser = { cdp: o.cdp, headed: o.headed };
const say = (s) => console.log(s);

async function lessonsFor(kind) {
  const stores = [join(skill, "learning", "lessons.jsonl"), join(dirname(dir), "seemly-local", "lessons.jsonl")].filter(existsSync);
  if (!stores.length) return [];
  const { LessonStore } = await import(join(skill, "learning", "lessons.mjs"));
  const seen = new Map();
  for (const p of stores) for (const l of new LessonStore(p).select({ phase: "build", kind })) seen.set(l.id, l);
  return [...seen.values()].slice(0, 20);
}

function pendingRows() {
  const p = join(dir, "pending-writes.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function status(g) {
  const s = g.stats();
  const st = loadState(dir);
  const pr = st.order.length ? progress(st) : null;
  const pend = pendingRows().length;
  say(`GRAPH   ${s.nodes} nodes, ${s.edges} edges, ${s.templates} templates, ${s.modules} module archetypes`);
  say(`STATUS  ${Object.entries(s.byStatus).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  say(`QUEUE   frontier ${s.frontier}${g.isClosed() ? " · CLOSED" : ""}${pend ? ` · ${pend} write(s) pending BLOCKED` : ""}`);
  if (pr) say(`BUILD   ${pr.units} units: ${UNITS(pr)}`);
}
const UNITS = (pr) => ["pending", "building", "built", "verified"].map((k) => `${k} ${pr[k]}`).join(" · ");

const g = open(dir, {});
switch (cmd) {
  case "init": {
    if (!o.target) throw new Error("init needs --target <url>");
    const t = new URL(o.target);
    g.data.meta.target = o.target;
    g.data.meta.origin = t.origin;
    g.data.meta.prefix = o.prefix?.length > 1 ? o.prefix : (o.prefix?.[0] ?? (t.pathname.replace(/\/[^/]*$/, "") || "/"));
    for (const url of [o.target, ...o.entry]) {
      const { node, isNew } = await readEntry(g, url, browser);
      say(`${isNew ? "entry" : "known"} ${node.id} ${node.label}`);
    }
    save(g, dir);
    say(`scope ${g.data.meta.origin} ${[g.data.meta.prefix].flat().join(" ")}`);
    break;
  }
  case "visit": {
    const { node, isNew } = await readEntry(g, positionals[0], browser);
    save(g, dir);
    say(`${isNew ? "entry" : "known"} ${node.id} ${node.label}`);
    break;
  }
  case "explore": {
    if (!g.data.meta.origin) throw new Error("run init first");
    if (!["off", "auto"].includes(o["read-posts"])) throw new Error("--read-posts is off or auto");
    // --relogin-wait <minutes>: a lost login does not end the run. It prints what to do, waits
    // for the saved-login file (SEEMLY_STORAGE_STATE) to be rewritten by export-login, and goes
    // on, so a time-boxed reference (a sandbox) loses minutes to a timeout, not the walk.
    const waitMin = o["relogin-wait"] ? +o["relogin-wait"] : 0;
    const stateFile = process.env.SEEMLY_STORAGE_STATE;
    let maxNodes = o["max-nodes"] ? +o["max-nodes"] : Infinity;
    for (;;) {
      try {
        const r = await explore(g, dir, {
          ...browser,
          maxNodes,
          risky: o.risky,
          allowPost: o["allow-post"].map((s) => new RegExp(s)),
          readPosts: o["read-posts"],
          pace: o.pace ? +o.pace : 0,
          sample: o.sample ? +o.sample : undefined,
          onlyPrefix: o["only-prefix"]?.length ? o["only-prefix"] : null,
        });
        writeTree(g, dir);
        writeLive(g, dir);
        say(`expanded ${r.expanded} node(s); graph ${r.closed ? "CLOSED" : "still open"}${r.ownOpen !== undefined ? `; ${r.ownOpen} open in this worker's area` : ""}`);
        status(g);
        break;
      } catch (e) {
        if (!(e instanceof SessionLost)) throw e;
        writeTree(g, dir);
        if (!waitMin || !stateFile || !existsSync(stateFile)) {
          say(`BLOCKED: ${e.message}. Log in again in the headed profile, then re-run explore.`);
          process.exitCode = 3;
          break;
        }
        const before = statSync(stateFile).mtimeMs;
        say(`LOGIN LOST: ${e.message}. Log in again in the headed window and re-run export-login to ${stateFile}; waiting up to ${waitMin} min.`);
        const deadline = Date.now() + waitMin * 60_000;
        while (Date.now() < deadline && statSync(stateFile).mtimeMs === before) await new Promise((r) => setTimeout(r, 5000));
        if (statSync(stateFile).mtimeMs === before) {
          say(`BLOCKED: no new login within ${waitMin} min. Re-run explore after logging in.`);
          process.exitCode = 3;
          break;
        }
        say("login refreshed; resuming the walk");
      }
    }
    break;
  }
  case "requeue": {
    // --failed: every node a run gave up on (status gap, detail "explore failed ..."), e.g. after
    // the browser died under it.
    const ids = positionals[0] === "--failed" || o.failed
      ? Object.values(g.data.nodes).filter((n) => (n.status === "gap" && /^explore failed/.test(n.detail ?? ""))).map((n) => n.id)
      : [positionals[0]];
    for (const id of ids) {
      g.node(id).attempts = 0;
      g.setStatus(id, "frontier", null);
    }
    save(g, dir);
    say(`requeued ${ids.length} node(s)`);
    break;
  }
  case "gap": {
    if (!o.reason) throw new Error("gap needs --reason");
    g.setStatus(positionals[0], "gap", o.reason);
    save(g, dir);
    say(`gap ${positionals[0]}: ${o.reason}`);
    break;
  }
  case "pending":
    for (const p of pendingRows()) say(`${p.node} ${p.element.role} "${p.element.name}" on ${p.label}: ${p.why}`);
    break;
  case "plan": {
    const st = plan(g, loadState(dir), { allowOpen: o["allow-open"] });
    saveState(dir, st);
    say(st.order.map((u, i) => `${String(i + 1).padStart(3)}. ${u.padEnd(6)} ${st.units[u].kind.padEnd(8)} ${st.units[u].status.padEnd(8)} deps: ${st.units[u].deps.join(",") || "-"}`).join("\n"));
    if (st.skipped.length) say(`not built (placeholders): ${st.skipped.join(", ")}`);
    break;
  }
  case "next-unit": {
    const st = loadState(dir);
    if (!st.order.length) throw new Error("run plan first");
    const unit = nextUnit(st);
    saveState(dir, st);
    if (!unit) {
      say(Object.values(st.units).every((u) => u.status === "built" || u.status === "verified") ? "ALL UNITS BUILT" : "nothing ready: a unit is waiting on one still building");
      break;
    }
    const pend = pendingRows().filter((p) => unit.members.includes(p.node));
    const p = writePacket(dir, unit.id, packet(g, st, unit.id, { lessons: await lessonsFor(unit.kind), pending: pend, skill }));
    say(`${unit.id} (${unit.kind}) -> ${p}`);
    break;
  }
  case "packet": {
    const st = loadState(dir);
    const unit = st.units[positionals[0]];
    const pend = pendingRows().filter((p) => unit?.members.includes(p.node));
    say(writePacket(dir, positionals[0], packet(g, st, positionals[0], { lessons: await lessonsFor(unit?.kind), pending: pend, skill })));
    break;
  }
  case "unit-done": {
    const st = loadState(dir);
    const unit = finish(g, st, positionals[0], { verified: o.verified });
    saveState(dir, st);
    save(g, dir);
    writeLive(g, dir);
    say(`${unit.id} ${unit.status}; ${UNITS(progress(st))}`);
    break;
  }
  case "compare": {
    // compare --ref <dir>... --clone <dir>... [--out diff.md]: the walked-graph diff
    const md = toMarkdown(compare(o.ref, o.clone));
    if (o.out) writeFileSync(o.out, md);
    say(o.out ? `wrote ${o.out}` : md);
    break;
  }
  case "status":
    status(g);
    break;
  case "tree":
    say(writeTree(g, dir));
    break;
  case "live":
    say(writeLive(g, dir));
    break;
  case "frontier":
    for (const id of g.frontierOrder()) say(`${id} ${g.data.nodes[id].label}`);
    break;
  case "route": {
    const path = g.route(positionals[0]);
    if (!path) say("unreachable without a write");
    else for (const e of path) say(`${e.kind.padEnd(10)} ${e.element.name ?? e.element.css ?? ""}  ->  ${g.data.nodes[e.to].label}`);
    break;
  }
  case "loops":
    for (const c of g.loops()) say(c.map((id) => g.data.nodes[id].label).join("  <->  "));
    break;
  default:
    say(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exitCode = cmd ? 2 : 0;
}

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
