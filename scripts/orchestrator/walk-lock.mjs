// Who is writing a graph dir. store.mjs rewrites graph.json whole from each process's in-memory
// copy, so a command that rewrites a dir's saved captures (`O relabel`) must not run while a walk
// is writing it. Two files say a dir is busy:
//   supervise.pid  written by `O supervise` for its whole life (it is idle between chunks)
//   walk.lock      written by `O explore` and `O relabel` while they run: { pid, cmd, started }
// A file whose pid is no longer running is stale (a killed walk) and is ignored.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SUPERVISE_PID = "supervise.pid";
export const WALK_LOCK = "walk.lock";

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function read(file) {
  try {
    const raw = readFileSync(file, "utf8").trim();
    const j = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw) };
    return { ...j, pid: Number(j.pid) };
  } catch {
    return null;
  }
}

/**
 * The live holders of `dir`: [{ file, pid, cmd }] for each lock file whose pid is running and is
 * not this process. Stale files are listed under `stale`.
 */
export function holders(dir) {
  const live = [];
  const stale = [];
  for (const name of [SUPERVISE_PID, WALK_LOCK]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const h = read(file);
    const row = { file, pid: h?.pid ?? null, cmd: h?.cmd ?? (name === SUPERVISE_PID ? "supervise" : "?") };
    if (h && h.pid === process.pid) continue;
    (h && alive(h.pid) ? live : stale).push(row);
  }
  return { live, stale };
}

export class DirBusy extends Error {}

/**
 * Take `dir` for `cmd`: throws DirBusy when a live process holds it, by `walk.lock` or by
 * `supervise.pid`. `supervisor` is the pid of the supervise this process is a chunk of
 * (SEEMLY_SUPERVISE_PID, set by supervise.mjs): its supervise.pid does not count. Returns the
 * release function; a stale walk.lock is overwritten.
 */
export function acquire(dir, cmd, { supervisor = Number(process.env.SEEMLY_SUPERVISE_PID) || null } = {}) {
  const busy = holders(dir).live.filter((h) => !(supervisor && h.file.endsWith(SUPERVISE_PID) && h.pid === supervisor));
  if (busy.length) throw new DirBusy(`${dir} is busy: ${busy.map((h) => `${h.cmd} pid ${h.pid} (${h.file})`).join(", ")}; wait for it to finish or stop it`);
  const file = join(dir, WALK_LOCK);
  writeFileSync(file, JSON.stringify({ pid: process.pid, cmd, started: new Date().toISOString() }));
  return () => {
    if (read(file)?.pid === process.pid) rmSync(file, { force: true });
  };
}

/** supervise.pid for the life of `O supervise`; returns the release function. */
export function markSupervise(dir) {
  const file = join(dir, SUPERVISE_PID);
  const busy = holders(dir).live;
  if (busy.length) throw new DirBusy(`${dir} is busy: ${busy.map((h) => `${h.cmd} pid ${h.pid} (${h.file})`).join(", ")}`);
  writeFileSync(file, String(process.pid));
  const release = () => {
    if (read(file)?.pid === process.pid) rmSync(file, { force: true });
  };
  process.once("exit", release);
  return release;
}
