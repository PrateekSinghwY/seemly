// Colour management for the pixel check. A screenshot taken on a Mac display can carry a
// Display P3 ICC profile (iCCP) or gAMA/cHRM chunks; its raw samples are not sRGB, so diffing
// them against an sRGB clone shot reports false differences (or hides real ones) on every
// coloured region. `toSrgb` converts a decoded image to sRGB, or names the profile it cannot
// handle so the caller records the check as skipped, never as a pass.
//
// Supported: no colour chunk (sRGB assumed), an sRGB chunk, any RGB matrix/TRC ICC profile
// (Display P3, sRGB, Adobe RGB, a calibrated display profile), and gAMA with optional cHRM.

import { inflateSync } from "node:zlib";

const D50 = [0.9642, 1, 0.8249];
// sRGB primaries adapted to the D50 PCS (the sRGB IEC61966-2.1 ICC profile's rXYZ/gXYZ/bXYZ), as columns.
const SRGB_D50 = [
  [0.4360747, 0.3850649, 0.1430804],
  [0.2225045, 0.7168786, 0.0606169],
  [0.0139322, 0.0971045, 0.7141733],
];
const SRGB_PRIMARIES = { white: [0.3127, 0.329], red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06] };

const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgbEncode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

const mul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const apply = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
function inv(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

// ---------- ICC ----------

const s15 = (b, o) => b.readInt32BE(o) / 65536;

function iccDesc(p, tags) {
  const t = tags.desc;
  if (!t) return null;
  const type = p.toString("latin1", t.off, t.off + 4);
  if (type === "desc") return p.toString("latin1", t.off + 12, t.off + 12 + p.readUInt32BE(t.off + 8)).replace(/\0+$/, "");
  if (type === "mluc" && p.readUInt32BE(t.off + 8) > 0) {
    const len = p.readUInt32BE(t.off + 20);
    const at = t.off + p.readUInt32BE(t.off + 24);
    return Buffer.from(p.subarray(at, at + len)).swap16().toString("utf16le").replace(/\0+$/, "");
  }
  return null;
}

/** An ICC tone curve (curv or para) as a 256-entry 8-bit-to-linear table, or null. */
function iccCurve(p, t) {
  if (!t) return null;
  const type = p.toString("latin1", t.off, t.off + 4);
  let f;
  if (type === "curv") {
    const n = p.readUInt32BE(t.off + 8);
    if (n === 0) f = (x) => x;
    else if (n === 1) {
      const g = p.readUInt16BE(t.off + 12) / 256;
      f = (x) => x ** g;
    } else {
      const tab = Array.from({ length: n }, (_, k) => p.readUInt16BE(t.off + 12 + 2 * k) / 65535);
      f = (x) => {
        const pos = x * (n - 1);
        const k = Math.min(n - 2, Math.floor(pos));
        return tab[k] + (tab[k + 1] - tab[k]) * (pos - k);
      };
    }
  } else if (type === "para") {
    const fn = p.readUInt16BE(t.off + 8);
    const count = [1, 3, 4, 5, 7][fn];
    if (count === undefined) return null;
    const [g, a, b, c, d, e, ff] = Array.from({ length: count }, (_, k) => s15(p, t.off + 12 + 4 * k));
    f = [
      (x) => x ** g,
      (x) => (x >= -b / a ? (a * x + b) ** g : 0),
      (x) => (x >= -b / a ? (a * x + b) ** g + c : c),
      (x) => (x >= d ? (a * x + b) ** g : c * x),
      (x) => (x >= d ? (a * x + b) ** g + e : c * x + ff),
    ][fn];
  } else return null;
  return Array.from({ length: 256 }, (_, v) => f(v / 255));
}

/**
 * Parse an ICC profile into `{ desc, matrix, curves }` (matrix: linear RGB to D50 XYZ, as rows),
 * or `{ desc, unsupported: true }` for a profile that is not an RGB matrix/TRC profile.
 */
export function parseIcc(p) {
  const tags = {};
  const n = p.length >= 132 ? p.readUInt32BE(128) : 0;
  for (let k = 0; k < n; k++) {
    const e = 132 + 12 * k;
    tags[p.toString("latin1", e, e + 4)] = { off: p.readUInt32BE(e + 4), size: p.readUInt32BE(e + 8) };
  }
  const desc = iccDesc(p, tags) ?? "unnamed profile";
  const space = p.toString("latin1", 16, 20);
  const xyz = (sig) => {
    const t = tags[sig];
    return t && p.toString("latin1", t.off, t.off + 4) === "XYZ " ? [s15(p, t.off + 8), s15(p, t.off + 12), s15(p, t.off + 16)] : null;
  };
  const cols = ["rXYZ", "gXYZ", "bXYZ"].map(xyz);
  const curves = ["rTRC", "gTRC", "bTRC"].map((s) => iccCurve(p, tags[s]));
  if (space !== "RGB " || cols.some((c) => !c) || curves.some((c) => !c)) return { desc, unsupported: true };
  return { desc, matrix: [0, 1, 2].map((i) => cols.map((c) => c[i])), curves };
}

// ---------- gAMA / cHRM ----------

/** RGB-to-XYZ matrix for chromaticities, Bradford-adapted from their white point to D50. */
function chromaMatrix({ white, red, green, blue }) {
  const XYZ = ([x, y]) => [x / y, 1, (1 - x - y) / y];
  const P = [red, green, blue].map(XYZ);
  const M = [0, 1, 2].map((i) => P.map((c) => c[i]));
  const W = XYZ(white);
  const S = apply(inv(M), W);
  const toWhite = M.map((row) => row.map((v, j) => v * S[j]));
  const BR = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
  const ws = apply(BR, W);
  const wd = apply(BR, D50);
  const scale = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? wd[i] / ws[i] : 0)));
  return mul(mul(mul(inv(BR), scale), BR), toWhite);
}

const near = (a, b, eps) => a.every((row, i) => row.every((v, j) => Math.abs(v - b[i][j]) <= eps));
const isSrgbCurve = (c) => c.every((v, k) => Math.abs(v - srgbDecode(k / 255)) * 255 < 0.5);

// ---------- convert ----------

/**
 * Describe the colour space a decoded PNG declares. `color` is what `decodePng` collected:
 * `{ iccp: { name, profile } | undefined, srgb: boolean, gama: number | undefined, chrm: {...} | undefined }`.
 * Returns `{ name, srgb: true }`, `{ name, matrix, curves }`, or `{ name, unsupported: true }`.
 */
export function colourSpace(color = {}) {
  // PNG precedence: iCCP, then sRGB, then cHRM/gAMA. No chunk at all is taken as sRGB.
  if (color.iccp) {
    let prof;
    try {
      prof = parseIcc(inflateSync(color.iccp.profile));
    } catch {
      return { name: color.iccp.name || "unreadable ICC profile", unsupported: true };
    }
    const name = prof.desc === "unnamed profile" && color.iccp.name ? color.iccp.name : prof.desc;
    if (prof.unsupported) return { name, unsupported: true };
    if (near(prof.matrix, SRGB_D50, 0.002) && prof.curves.every(isSrgbCurve)) return { name, srgb: true };
    return { name, matrix: prof.matrix, curves: prof.curves };
  }
  if (color.srgb) return { name: "sRGB chunk", srgb: true };
  if (color.gama === undefined && !color.chrm) return { name: "untagged (sRGB assumed)", srgb: true };
  const prim = color.chrm ?? SRGB_PRIMARIES;
  const g = color.gama ?? 1 / 2.2;
  const primSrgb = Object.keys(SRGB_PRIMARIES).every((k) => prim[k].every((v, i) => Math.abs(v - SRGB_PRIMARIES[k][i]) < 0.002));
  const name = `gAMA ${g.toFixed(5)}${color.chrm ? " + cHRM" : ""}`;
  // The PNG spec's sRGB fallback: gAMA 45455 with sRGB chromaticities is sRGB.
  if (primSrgb && Math.abs(g - 0.45455) < 0.0001) return { name, srgb: true };
  const curve = Array.from({ length: 256 }, (_, v) => (v / 255) ** (1 / g));
  return { name, matrix: chromaMatrix(prim), curves: [curve, curve, curve] };
}

/**
 * Convert a decoded image (from `decodePng`, with its `color`) to sRGB samples.
 * Returns `{ image, profile }` where `profile` names the source space and `converted` says
 * whether any sample changed, or `{ unsupported: <profile name> }`.
 */
export function toSrgb(img) {
  const cs = colourSpace(img.color);
  if (cs.unsupported) return { unsupported: cs.name };
  if (cs.srgb) return { image: img, profile: cs.name, converted: false };
  const m = mul(inv(SRGB_D50), cs.matrix);
  const ENC = 4096;
  const enc = Uint8Array.from({ length: ENC + 1 }, (_, k) => Math.round(srgbEncode(k / ENC) * 255));
  const [lr, lg, lb] = cs.curves;
  const out = Buffer.from(img.data);
  const cache = new Map();
  for (let i = 0; i < out.length; i += 4) {
    const key = (out[i] << 16) | (out[i + 1] << 8) | out[i + 2];
    let rgb = cache.get(key);
    if (!rgb) {
      const lin = [lr[out[i]], lg[out[i + 1]], lb[out[i + 2]]];
      rgb = apply(m, lin).map((v) => enc[Math.round(Math.min(1, Math.max(0, v)) * ENC)]);
      if (cache.size < 1 << 16) cache.set(key, rgb);
    }
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
  }
  return { image: { ...img, data: out }, profile: cs.name, converted: true };
}
