// Scope and STATE_BOUND (SKILL.md section 4): what the explorer may follow, and when a family
// of URLs has been sampled enough. Pure functions over a plain object kept in graph meta, so a
// resumed run keeps its counts.

/** Linked values kept per family before the rest are recorded as out of range. */
export const STATE_BOUND = 30;

const ID_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{12,}$/i,
  /^\d{4}-\d{2}(-\d{2})?$/,
  /^(?=.*\d)[A-Za-z0-9_-]{16,}$/,
  /^(?=[^-]*[a-z])(?=.*\d)[a-z0-9]+(-[a-z0-9]+)*-\d+$/i,
];

/** `/listing/123/edit` and `/listing/456/edit` are one family: `/listing/:id/edit`. */
export function pathPattern(pathname) {
  return pathname
    .split("/")
    .map((s) => (s && ID_SEGMENT.some((re) => re.test(decodeURIComponent(s))) ? ":id" : s))
    .join("/");
}

/** Same origin and under one of the build's path prefixes (one, or a list for a multi-area scope). */
export function inScope(raw, { origin, prefix = "/" }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol) || u.origin !== origin) return false;
  return (Array.isArray(prefix) ? prefix : [prefix]).some((pre) => {
    const p = pre.endsWith("/") ? pre : `${pre}/`;
    return pre === "/" || u.pathname === pre || u.pathname.startsWith(p);
  });
}

/**
 * Admit one discovered URL against the bounds. A URL already admitted is always admitted
 * again (dedupe happens in the graph). Returns `{ ok: true }` or `{ ok: false, bound }` where
 * `bound` says which family hit its limit, for the node's `bound` field.
 */
export function admit(bounds, raw, limit = STATE_BOUND) {
  bounds.paths ??= {};
  bounds.query ??= {};
  const u = new URL(raw);
  const pattern = `${u.origin}${pathPattern(u.pathname)}`;
  const concrete = `${u.origin}${u.pathname}`;
  const fam = (bounds.paths[pattern] ??= { kept: [], over: 0 });
  if (!fam.kept.includes(concrete)) {
    if (pattern !== concrete && fam.kept.length >= limit) {
      fam.over++;
      return { ok: false, bound: `path family ${pattern}: ${limit} kept, ${fam.over} more out of range` };
    }
    fam.kept.push(concrete);
  }
  for (const [k, v] of new URL(raw).searchParams) {
    const key = `${concrete}?${k}`;
    const q = (bounds.query[key] ??= { kept: [], over: 0 });
    if (q.kept.includes(v)) continue;
    if (q.kept.length >= limit) {
      q.over++;
      return { ok: false, bound: `query ${key}: ${limit} values kept, ${q.over} more out of range` };
    }
    q.kept.push(v);
  }
  return { ok: true };
}

/**
 * Repeated siblings (table rows, cards in a grid) share a css path up to their nth-of-type
 * indexes. The explorer samples a group instead of clicking all 999 rows: the first few, and
 * more only while they keep leading somewhere new.
 */
export function repeatGroup(css) {
  return css.replace(/:nth-of-type\(\d+\)/g, "");
}
