// Oracle coverage in two dimensions (ASSUMPTIONS A13, defect E05 "oracle-blind").
//
// A row-only measure reports 100% while a whole column is missing: col-one and col-two
// cover every row that col-three should also cover. So coverage here is AREA, measured
// per CSS-pixel row as the union of the region intervals that cross it.
//
// Page background between modules is not a hole anyone can clip. A gap of at most
// `margin` CSS px with covered pixels on BOTH sides is a gutter (horizontal) or an
// inter-module margin (vertical) and counts as covered. A gap at the frame's edge, or a
// wider one, is a hole.
//
// The frame is the horizontal span of all listed regions: full-width bands (header, nav,
// footer) set it, so a missing column is a hole inside the frame, not outside it.
//
//   regions: [{ box: [x, y, w, h] }]  (CSS px, masked regions included)
//   returns { pct, frame: [x0, x1], holes: [{ y0, y1, x0, x1 }] }
export function coverage2d(regions, pageW, pageH, margin = 30) {
  const boxes = regions.map(r => r.box).filter(b => b && b[2] > 0 && b[3] > 0);
  if (!boxes.length || pageH <= 0 || pageW <= 0) return { pct: 0, frame: [0, 0], holes: [] };
  const fx0 = Math.max(0, Math.min(...boxes.map(b => b[0])));
  const fx1 = Math.min(pageW, Math.max(...boxes.map(b => b[0] + b[2])));
  const frameW = fx1 - fx0;
  if (frameW <= 0) return { pct: 0, frame: [fx0, fx1], holes: [] };

  // per row: merged intervals, horizontal gutters filled
  const rows = new Array(pageH);
  for (let y = 0; y < pageH; y++) {
    const iv = [];
    for (const [x, by, w, h] of boxes) {
      if (y < by || y >= by + h) continue;
      const a = Math.max(fx0, x), z = Math.min(fx1, x + w);
      if (z > a) iv.push([a, z]);
    }
    iv.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [a, z] of iv) {
      const last = merged[merged.length - 1];
      if (last && a - last[1] <= margin) last[1] = Math.max(last[1], z);
      else merged.push([a, z]);
    }
    rows[y] = merged;
  }

  // vertical margins: an empty run no taller than `margin`, bounded by non-empty rows
  for (let y = 0; y < pageH; y++) {
    if (rows[y].length) continue;
    let end = y; while (end < pageH && !rows[end].length) end++;
    if (end - y <= margin && y > 0 && end < pageH) {
      // fill with the intersection of the rows above and below, never more
      const fill = intersect(rows[y - 1], rows[end]);
      for (let k = y; k < end; k++) rows[k] = fill;
    }
    y = end;
  }

  let covered = 0;
  const holes = [];
  for (let y = 0; y < pageH; y++) {
    let cursor = fx0;
    for (const [a, z] of rows[y]) {
      if (a > cursor) holes.push({ y0: y, y1: y + 1, x0: cursor, x1: a });
      covered += z - a; cursor = z;
    }
    if (cursor < fx1) holes.push({ y0: y, y1: y + 1, x0: cursor, x1: fx1 });
  }
  return { pct: covered / (frameW * pageH) * 100, frame: [fx0, fx1], holes: mergeHoles(holes) };
}

function intersect(p, q) {
  const out = [];
  for (const [a, z] of p) for (const [b, w] of q) {
    const s = Math.max(a, b), e = Math.min(z, w);
    if (e > s) out.push([s, e]);
  }
  return out;
}

// Stack identical one-row holes into blocks so a report names a few rectangles.
function mergeHoles(holes) {
  const open = new Map(), out = [];
  for (const h of holes) {
    const k = `${h.x0}:${h.x1}`, prev = open.get(k);
    if (prev && prev.y1 === h.y0) prev.y1 = h.y1;
    else { const n = { ...h }; open.set(k, n); out.push(n); }
  }
  return out;
}
