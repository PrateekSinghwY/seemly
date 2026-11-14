// Colour-profile fixtures for the pixel check: ICC profiles built byte by byte and PNGs that
// embed them. Run `node color.mjs --write` to rewrite the PNGs under fixture/color/.
//
// The expected sRGB values are derived here with the D65 matrices (not the D50 ICC colorants
// png-color.mjs uses), so the test checks the conversion against an independent derivation.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { encodePng } from "../../verify.mjs";

export const DIR = join(dirname(fileURLToPath(import.meta.url)), "color");

const s15 = (v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(v * 65536));
  return b;
};
const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
const sig = (s) => Buffer.from(s, "latin1");
const xyzTag = (x, y, z) => Buffer.concat([sig("XYZ "), Buffer.alloc(4), s15(x), s15(y), s15(z)]);
// para function 3: the sRGB transfer curve (Display P3 uses it too).
const srgbPara = () => {
  const head = Buffer.alloc(12);
  head.write("para", 0, "latin1");
  head.writeUInt16BE(3, 8);
  return Buffer.concat([head, ...[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].map(s15)]);
};
const mlucTag = (text) => {
  const str = Buffer.from(text, "utf16le").swap16();
  const head = Buffer.alloc(28);
  head.write("mluc", 0, "latin1");
  head.writeUInt32BE(1, 8);
  head.writeUInt32BE(12, 12);
  head.write("enUS", 16, "latin1");
  head.writeUInt32BE(str.length, 20);
  head.writeUInt32BE(28, 24);
  return Buffer.concat([head, str]);
};
const descTag = (text) => {
  const head = Buffer.alloc(12);
  head.write("desc", 0, "latin1");
  head.writeUInt32BE(text.length + 1, 8);
  return Buffer.concat([head, sig(text), Buffer.alloc(1 + 4 + 4 + 2 + 1 + 67)]);
};

/** An ICC profile from `[signature, body]` tags; bodies are shared when they are the same Buffer. */
export function iccProfile(space, tags) {
  const tableLen = 4 + 12 * tags.length;
  let off = 128 + tableLen;
  const placed = new Map();
  const bodies = [];
  const table = Buffer.alloc(tableLen);
  table.writeUInt32BE(tags.length, 0);
  tags.forEach(([name, body], k) => {
    if (!placed.has(body)) {
      placed.set(body, off);
      bodies.push(pad4(body));
      off += pad4(body).length;
    }
    table.write(name, 4 + 12 * k, "latin1");
    table.writeUInt32BE(placed.get(body), 8 + 12 * k);
    table.writeUInt32BE(body.length, 12 + 12 * k);
  });
  const head = Buffer.alloc(128);
  head.writeUInt32BE(off, 0);
  head.writeUInt32BE(0x04300000, 8);
  head.write("mntr", 12, "latin1");
  head.write(space, 16, "latin1");
  head.write("XYZ ", 20, "latin1");
  head.write("acsp", 36, "latin1");
  s15(0.9642).copy(head, 68);
  s15(1).copy(head, 72);
  s15(0.8249).copy(head, 76);
  return Buffer.concat([head, table, ...bodies]);
}

/** Display P3 as macOS ships it: P3 primaries adapted to D50, the sRGB tone curve. */
export function displayP3Profile() {
  const trc = srgbPara();
  return iccProfile("RGB ", [
    ["desc", mlucTag("Display P3")],
    ["wtpt", xyzTag(0.9642, 1, 0.8249)],
    ["rXYZ", xyzTag(0.515121, 0.241196, -0.001053)],
    ["gXYZ", xyzTag(0.291977, 0.692245, 0.041885)],
    ["bXYZ", xyzTag(0.157104, 0.066574, 0.784073)],
    ["rTRC", trc],
    ["gTRC", trc],
    ["bTRC", trc],
  ]);
}

/** An RGB profile with only a lookup table (no colorants), which the converter does not handle. */
export function lutOnlyProfile() {
  return iccProfile("RGB ", [["desc", descTag("Custom LUT Profile")], ["A2B0", Buffer.concat([sig("mft2"), Buffer.alloc(48)])]]);
}

export const iccpChunk = (name, profile) => ["iCCP", Buffer.concat([sig(name), Buffer.from([0, 0]), deflateSync(profile)])];

// ---------- colours ----------

const P3_D65 = [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0, 0.0451134, 1.0439444]];
const SRGB_D65 = [[0.4123908, 0.3575843, 0.1804808], [0.212639, 0.7151687, 0.0721923], [0.0193308, 0.1191948, 0.9505322]];
const dec = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const apply = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
function solve(m, y) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const col = (k) => m.map((r, j) => r.map((v, n) => (n === k ? y[j] : v)));
  return [0, 1, 2].map((k) => {
    const [[a2, b2, c2], [d2, e2, f2], [g2, h2, i2]] = col(k);
    return (a2 * (e2 * i2 - f2 * h2) - b2 * (d2 * i2 - f2 * g2) + c2 * (d2 * h2 - e2 * g2)) / det;
  });
}
/** The P3 samples that display as this sRGB colour. */
export const srgbToP3 = (rgb) => solve(P3_D65, apply(SRGB_D65, rgb.map((v) => dec(v / 255)))).map((v) => Math.round(enc(Math.min(1, Math.max(0, v))) * 255));
export const p3ToSrgb = (rgb) => solve(SRGB_D65, apply(P3_D65, rgb.map((v) => dec(v / 255)))).map((v) => Math.round(enc(Math.min(1, Math.max(0, v))) * 255));

/** Swatches in sRGB: brand-like saturated colours plus neutrals, which P3 leaves alone. */
export const SWATCHES = [[220, 12, 34], [0, 120, 212], [16, 160, 80], [255, 196, 0], [128, 0, 128], [255, 255, 255], [40, 40, 40], [128, 128, 128]];

/** A strip of 8x8 swatches, in sRGB or as P3 samples. */
export function swatchImage(colours) {
  const width = colours.length * 8;
  const height = 8;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...colours[Math.floor(x / 8)], 255], (y * width + x) * 4);
  return { width, height, data };
}

export function writeFixtures() {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "srgb.png"), encodePng(swatchImage(SWATCHES), [["sRGB", Buffer.from([0])]]));
  writeFileSync(join(DIR, "p3.png"), encodePng(swatchImage(SWATCHES.map(srgbToP3)), [iccpChunk("ICC Profile", displayP3Profile())]));
  writeFileSync(join(DIR, "unsupported.png"), encodePng(swatchImage(SWATCHES), [iccpChunk("ICC Profile", lutOnlyProfile())]));
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) writeFixtures();
