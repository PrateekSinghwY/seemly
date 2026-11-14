#!/usr/bin/env node
// The coordinator. SKILL.md sections 4-5 drive the build through these commands; the graph
// decides what is next, never the builder. Run from the clone repo's root (or set RL_REPO).
//
//   explore phase
//     init --target <url> [--prefix /path]... [--entry <url>]...  create the graph from entry pages
//     explore [--max-nodes N] [--risky record|probe] [--allow-post <regex>]... [--read-posts off|auto]
//             [--pace <ms>] [--relogin-wait <minutes>] [--sample K] [--only-prefix /area]...
//             [--ws-guard block|off] [--retries N] [--backoff-ms N] [--login-pattern <regex>]
//             [--widths 1024,1280,...|off]                         label widths saved per node for verify
//     visit <url>                                                  add one more entry page
//     requeue <nodeId> | requeue --failed | requeue --gaps [--reason <r>] | gap <nodeId> --reason "..."
//                                                                  corrections; --gaps puts back every gap with a retryable reason
//     scope --map <scope.json>                                     tag every node with a scope (component id)
//     pending                                                      writes waiting for BLOCKED
//   build phase
//     plan [--allow-open]                                          units in dependency order
//     next-unit                                                    claim the next unit, write its packet
//     packet <unit>                                                rewrite one unit's packet
//     unit-done <unit> [--verified]
//   verify phase (Phase D)
//     verify --ref <dir>... --clone <dir> [--scope id] [--node id] [--masks masks.json] [--writes writes.json]
//            [--styles-allow styles-allow.json] [--ws-map ws-map.json] [--dead-controls]
//            [--ref-prefix p] [--clone-prefix p] [--dpr 1] [--api url] [--web url]
//     report [--clone <dir>] [--scope id] [--out report.md]        ref node -> clone node -> each check -> reason
//   views
//     status [--scope id] [--clone <dir>] | tree [--scope id] | live | frontier | route <nodeId> | loops
//     compare --ref <dir>... --clone <dir>... [--scope id] [--out diff.md]   walk diff; writes <clone>/pairs.json
//   (any) --dir <discovery dir>   --cdp <http://127.0.0.1:9222>   --headed

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DISCOVERY } from "../lib/pw.mjs";
import { finish, loadState, nextUnit, packet, plan, progress, saveState, writePacket } from "./build.mjs";
import { compare, pairNodes, toMarkdown } from "./compare.mjs";
import { breadcrumbFromAria, isRetryableReason, tagScopes } from "./graph.mjs";
import { open, save } from "./store.mjs";
import { countsLine, report, verify, verifyCounts, writePairs } from "./verify.mjs";
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
    gaps: { type: "boolean", default: false },
    map: { type: "string" },
    scope: { type: "string" },
    node: { type: "string" },
    masks: { type: "string" },
    writes: { type: "string" },
    "ref-prefix": { type: "string", default: "" },
    "clone-prefix": { type: "string", default: "" },
    dpr: { type: "string", default: "1" },
    height: { type: "string", default: "900" },
    api: { type: "string" },
    web: { type: "string" },
    // Walker options (explore.mjs): passed only when given, so a walker without them ignores them.
    "ws-guard": { type: "string" },
    retries: { type: "string" },
    "backoff-ms": { type: "string" },
    "login-pattern": { type: "string" },
    widths: { type: "string" },
    "styles-allow": { type: "string" },
    "ws-map": { type: "string" },
    "dead-controls": { type: "boolean", default: false },
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

function status(g, scope) {
  const s = g.stats(scope);
  const st = loadState(dir);
  const pr = st.order.length && !scope ? progress(st) : null;
  const pend = pendingRows().filter((p) => !scope || g.data.nodes[p.node]?.scope === scope).length;
  if (scope) say(`SCOPE   ${scope}`);
  say(`GRAPH   ${s.nodes} nodes, ${s.edges} edges, ${s.templates} templates, ${s.modules} module archetypes`);
  say(`STATUS  ${Object.entries(s.byStatus).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  say(`QUEUE   frontier ${s.frontier}${!scope && g.isClosed() ? " · CLOSED" : ""}${pend ? ` · ${pend} write(s) pending BLOCKED` : ""}`);
  if (pr) say(`BUILD   ${pr.units} units: ${UNITS(pr)}`);
  // Phase D counts come from pairs.json, the clone graph and the check records on disk.
  const vdir = o.clone?.[0] ?? dir;
  const c = existsSync(join(vdir, "pairs.json")) ? verifyCounts(vdir, scope) : null;
  if (c) say(`VERIFY  ${countsLine(c)}`);
  if (g.data.meta.scopes && !scope) say(`SCOPES  ${Object.entries(g.data.meta.scopes.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}

/**
 * Which gap reasons a requeue retries: the walker's own `gapReason(n).retryable` when explore.mjs
 * exports it (its codes: transient, replay-not-found, http-auth ... retryable; out-of-scope,
 * http-4xx, write-only, manual not), else the graph's default rule. A gap with no reason at all
 * is always retried (graph.requeueGaps).
 */
function retryRule() {
  if (typeof walker.gapReason !== "function") return isRetryableReason;
  return (text, n) => {
    const r = walker.gapReason(n);
    return typeof r?.retryable === "boolean" ? r.retryable : isRetryableReason(text, n);
  };
}
/**
 * Walker options explore.mjs reads from its options object: the websocket guard (`wsGuard`,
 * block | off; websocket frames are captured either way), retries with backoff, and the
 * sign-in URL pattern. Only flags that were given are passed, so an explore.mjs that does not
 * know one ignores it and its own default stands.
 */
function walkerOptions() {
  const out = {};
  if (o["ws-guard"] !== undefined) {
    if (!["block", "off"].includes(o["ws-guard"])) throw new Error("--ws-guard is block or off");
    out.wsGuard = o["ws-guard"];
  }
  if (o.retries !== undefined) out.retries = +o.retries;
  if (o["backoff-ms"] !== undefined) out.backoffMs = +o["backoff-ms"];
  if (o["login-pattern"] !== undefined) out.loginPattern = o["login-pattern"];
  if (o.widths !== undefined) out.widths = o.widths === "off" ? "off" : o.widths.split(",").map(Number);
  return out;
}
const UNITS = (pr) => ["pending", "building", "built", "verified"].map((k) => `${k} ${pr[k]}`).join(" · ");

// The walker loads only for the commands that drive it, so the views, scope, compare, verify
// and report keep working while explore.mjs is being changed. `requeue` uses its gap rule when
// it loads and the graph's own rule when it does not.
const WALKS = new Set(["init", "visit", "explore"]);
let walker = {};
if (WALKS.has(cmd)) walker = await import("./explore.mjs");
else if (cmd === "requeue") walker = await import("./explore.mjs").catch((e) => (say(`note: explore.mjs did not load (${e.message.split("\n")[0]}); using the graph's retry rule`), {}));
const { SessionLost, explore, readEntry } = walker;

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
          ...walkerOptions(),
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
    // --gaps: every gap whose reason is retryable (a missing reason counts as retryable),
    // narrowed by --reason <text>.
    if (o.gaps) {
      const done = g.requeueGaps({ reason: o.reason, retryable: retryRule() });
      save(g, dir);
      for (const n of done) say(`requeued ${n.id} ${n.label}`);
      say(`requeued ${done.length} gap node(s)`);
      break;
    }
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
    // compare --ref <dir>... --clone <dir>... [--scope id] [--out diff.md]: the walked-graph diff,
    // plus the node pairs Phase D runs on, in <first clone dir>/pairs.json.
    if (!o.ref?.length || !o.clone?.length) throw new Error("compare needs --ref <dir>... --clone <dir>...");
    const md = toMarkdown(compare(o.ref, o.clone, { scope: o.scope }));
    const pairs = pairNodes(o.ref, o.clone);
    writePairs(o.clone[0], pairs);
    if (o.out) writeFileSync(o.out, md);
    say(o.out ? `wrote ${o.out}` : md);
    say(`pairs ${pairs.pairs.length} · ref-only ${pairs.refOnly.length} · clone-only ${pairs.cloneOnly.length} -> ${join(o.clone[0], "pairs.json")}`);
    break;
  }
  case "scope": {
    // scope --map <scope.json>: { "rules": [{ "scope": "S01", "url": "^/app/settings" }, ...], "inherit": true }
    if (!o.map) throw new Error("scope needs --map <scope.json>");
    const map = JSON.parse(readFileSync(o.map, "utf8"));
    const extra = (n) => {
      const p = n.info?.artifacts && join(dir, n.info.artifacts, "aria.yml");
      return p && existsSync(p) ? { breadcrumb: breadcrumbFromAria(readFileSync(p, "utf8")) } : {};
    };
    const counts = tagScopes(g, map, extra);
    g.data.meta.scopes.map = o.map;
    save(g, dir);
    say(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k.padEnd(12)} ${v}`).join("\n"));
    break;
  }
  case "verify": {
    if (!o.ref?.length || !o.clone?.length) throw new Error("verify needs --ref <ref graph dir>... --clone <clone graph dir>");
    const r = await verify({
      refDirs: o.ref, cloneDir: o.clone[0], scope: o.scope, node: o.node, masks: o.masks, writes: o.writes,
      stylesAllow: o["styles-allow"], wsMap: o["ws-map"], deadControls: o["dead-controls"],
      refPrefix: o["ref-prefix"], clonePrefix: o["clone-prefix"], dpr: +o.dpr, height: +o.height, api: o.api, web: o.web,
      log: say,
    });
    say(`VERIFY  ${countsLine(verifyCounts(o.clone[0], o.scope))}`);
    if (r.results.some((x) => !x.verify.passed)) process.exitCode = 1;
    break;
  }
  case "report": {
    const cdir = o.clone?.[0] ?? dir;
    const md = report(cdir, o.scope);
    const out = o.out ?? join(cdir, "verify", `report${o.scope ? `-${o.scope}` : ""}.md`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    say(`wrote ${out}`);
    say(`VERIFY  ${countsLine(verifyCounts(cdir, o.scope))}`);
    break;
  }
  case "status":
    status(g, o.scope);
    break;
  case "tree":
    say(writeTree(g, dir, { scope: o.scope }));
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
    say(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exitCode = cmd ? 2 : 0;
}

// Attached over CDP, the connection to the human's browser keeps the process alive; leave it open, exit.
process.exit(process.exitCode ?? 0);
