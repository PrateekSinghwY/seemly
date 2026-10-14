// Learn from what was fixed after the build, not only from what the human typed during it.
// Reads a repo's `fix:` commits (squash-merged PRs) and splits each body into its fix items;
// each item becomes a `post-build-fix` lesson candidate tagged by the code areas it touched.
// Candidates are proposals: distill decides which ones generalise.

import { execFileSync } from "node:child_process";

const SEP = "\u001e";
const FIELD = "\u001f";

/** Path → area tag. The first matching rule wins; unknown paths fall back to the top folder. */
export const AREA_RULES = [
  [/(^|\/)seed\//, "seed"],
  [/(^|\/)alembic\/|migrations?\//, "migration"],
  [/backend\/app\/(routers|api)\//, "api"],
  [/backend\/app\/services\//, "service"],
  [/backend\/app\/(models|schemas)\//, "schema"],
  [/frontend\/components\/([^/]+)\//, (m) => `ui:${m[1]}`],
  [/frontend\/app\//, "route"],
  [/frontend\/lib\//, "frontend-lib"],
  [/(^|\/)docs\//, "docs"],
  [/(^|\/)(scripts|\.github)\//, "tooling"],
];

export function areaOf(path) {
  for (const [re, tag] of AREA_RULES) {
    const m = path.match(re);
    if (m) return typeof tag === "function" ? tag(m) : tag;
  }
  return path.split("/")[0];
}

/**
 * Split a commit body into fix items. Recognises `**1. Title.** text` blocks and top-level
 * `- ` / `* ` bullets under a summary heading; stops at the visual-proof / test sections,
 * which describe verification, not defects. Falls back to the subject.
 */
export function items(subject, body) {
  const main = body.split(/^##\s+(visual proof|test|tests|testing|verification|screenshots|checklist)\b.*$/im)[0];
  const bold = [...main.matchAll(/^\*\*\d+\.\s*(.+?)\*\*\s*([\s\S]*?)(?=^\*\*\d+\.|^##\s|$(?![\s\S]))/gm)].map((m) => clean(`${m[1]} ${m[2]}`));
  if (bold.length) return bold;
  // A bullet runs until the next bullet, a blank line or a heading (wrapped lines are not indented).
  const bullets = [...main.matchAll(/^[-*]\s+(.+(?:\n(?![-*]\s|#|\s*$).+)*)/gm)].map((m) => clean(m[1]));
  if (bullets.length) return bullets;
  return [subject.replace(/^fix(\([^)]*\))?!?:\s*/, "").replace(/\s*\(#\d+\)$/, "")];
}

/**
 * A squash commit touches many areas; one fix item usually names its own. Keep the areas whose
 * component folder or file stem the item mentions, else fall back to every area of the commit.
 */
export function itemAreas(text, paths, areas) {
  const t = text.toLowerCase().replace(/[\s_-]+/g, ""); // "Trade Review" names TradeReview/
  const named = paths.filter((p) => {
    const stem = p.split("/").pop().replace(/\.[^.]+$/, "").toLowerCase();
    const folder = (p.match(/components\/([^/]+)\//)?.[1] ?? "").toLowerCase();
    return (stem.length > 3 && t.includes(stem)) || (folder.length > 3 && t.includes(folder));
  });
  return named.length ? [...new Set(named.map(areaOf))] : areas;
}

function clean(s) {
  return s.replace(/\s+/g, " ").replace(/`/g, "").trim().slice(0, 400);
}

/** `git log` over `range` (e.g. `v1..main`, or a since-date with `since`), fix commits only. */
export function mine(repo, { range = "HEAD", since, build } = {}) {
  const args = ["-C", repo, "log", range, "--no-merges", `--format=${SEP}%h${FIELD}%ad${FIELD}%s${FIELD}%b${FIELD}`, "--date=short", "--name-only"];
  if (since) args.push(`--since=${since}`);
  const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const candidates = [];
  for (const chunk of out.split(SEP).filter((c) => c.trim())) {
    const [hash, date, subject, body, files = ""] = chunk.split(FIELD);
    if (!/^fix(\(|!|:)/.test(subject)) continue;
    const paths = files.split("\n").map((f) => f.trim()).filter(Boolean);
    const areas = [...new Set(paths.map(areaOf))];
    for (const text of items(subject, body)) {
      candidates.push({
        summary: text,
        trigger: "post-build-fix",
        tags: { phase: ["build"], area: itemAreas(text, paths, areas) },
        build: build ?? `${repo.split("/").pop()}@${hash}`,
        evidence: `${hash} ${date} ${subject}`,
      });
    }
  }
  return candidates;
}
