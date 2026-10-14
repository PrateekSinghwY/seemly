// The single snapshot-choice rule. A re-capture writes a new `raw/<T1>/` beside T0, and
// every tool must then read the SAME snapshot: an oracle cut from T0 against module lists
// from T1 compares two different pages. `readdirSync` order is unspecified, and even
// sorted, `[0]` is the OLDEST stamp. The stamps are ISO-derived, so a lexical sort is
// chronological; the newest is the last.
import { existsSync, readdirSync } from 'fs';

export function latestStamp(root) {
  const raw = `${root}/raw`;
  if (!existsSync(raw)) return null;
  return readdirSync(raw, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
    .reverse()[0] ?? null;
}
