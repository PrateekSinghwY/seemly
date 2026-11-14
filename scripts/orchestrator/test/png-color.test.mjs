// Colour profiles in the pixel check: a Display P3 reference screenshot (a Mac capture) must be
// converted to sRGB before it is diffed against an sRGB clone shot, and a profile the converter
// cannot handle must skip the check by name, never pass it silently.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateSync } from "node:zlib";

import { colourSpace, parseIcc, toSrgb } from "../png-color.mjs";
import { decodePng, encodePng, pixelDiff, pixelInputs } from "../verify.mjs";
import { DIR, SWATCHES, displayP3Profile, iccpChunk, srgbToP3, swatchImage } from "./fixture/color.mjs";

const fixture = (name) => readFileSync(join(DIR, name));

test("colour: the P3 fixture's chunk is read and its profile named Display P3", () => {
  const img = decodePng(fixture("p3.png"));
  assert.equal(img.color.iccp.name, "ICC Profile");
  assert.equal(colourSpace(img.color).name, "Display P3");
  assert.equal(decodePng(fixture("srgb.png")).color.srgb, true);
});

test("colour: a Display P3 capture diffs unequal raw and equal once converted to sRGB", () => {
  const p3 = decodePng(fixture("p3.png"));
  const srgb = decodePng(fixture("srgb.png"));
  // Before conversion: every saturated swatch reads as a different colour.
  const raw = pixelDiff(p3, srgb);
  assert.ok(raw.differing >= 3 * 64, `raw P3 samples should differ on the saturated swatches, got ${raw.differing}`);
  // After conversion: equal.
  const px = pixelInputs(fixture("p3.png"), fixture("srgb.png"));
  assert.equal(px.skip, undefined);
  assert.equal(px.colour.ref, "Display P3");
  assert.equal(px.colour.converted, true);
  assert.equal(pixelDiff(px.ref, px.clone).differing, 0);
  // Close to the exact sRGB values sample by sample: 8-bit P3 rounding is magnified near black,
  // where the sRGB curve is steepest (a P3 blue of 0.4/255 is sRGB 3/255).
  for (let i = 0; i < px.ref.data.length; i++) assert.ok(Math.abs(px.ref.data[i] - px.clone.data[i]) <= 3, `sample ${i}: ${px.ref.data[i]} vs ${px.clone.data[i]}`);
});

test("colour: the measured case, P3 202,46,46 is sRGB #dc0c22", () => {
  const img = decodePng(encodePng(swatchImage([[202, 46, 46]]), [iccpChunk("Display P3", displayP3Profile())]));
  const { image, converted } = toSrgb(img);
  assert.equal(converted, true);
  assert.deepEqual([...image.data.subarray(0, 3)], [0xdc, 0x0c, 0x22]);
  assert.deepEqual(srgbToP3([0xdc, 0x0c, 0x22]), [202, 46, 46]);
});

test("colour: a real difference still fails after conversion", () => {
  const changed = SWATCHES.map((c, k) => (k === 1 ? [200, 50, 50] : c));
  const ref = encodePng(swatchImage(changed.map(srgbToP3)), [iccpChunk("ICC Profile", displayP3Profile())]);
  const px = pixelInputs(ref, fixture("srgb.png"));
  assert.equal(pixelDiff(px.ref, px.clone).differing, 64);
});

test("colour: an unsupported profile skips the pixel check by name", () => {
  const img = decodePng(fixture("unsupported.png"));
  assert.deepEqual(toSrgb(img), { unsupported: "Custom LUT Profile" });
  const px = pixelInputs(fixture("unsupported.png"), fixture("srgb.png"));
  assert.match(px.skip, /^unsupported colour profile Custom LUT Profile \(reference screenshot\)$/);
  assert.equal(px.ref, undefined);
  // On the clone side too, and an unreadable profile is unsupported, not a pass.
  assert.match(pixelInputs(fixture("srgb.png"), fixture("unsupported.png")).skip, /\(clone screenshot\)$/);
  const junk = ["iCCP", Buffer.concat([Buffer.from("Broken", "latin1"), Buffer.from([0, 0]), deflateSync(Buffer.from("not a profile"))])];
  assert.match(pixelInputs(encodePng(swatchImage(SWATCHES), [junk]), fixture("srgb.png")).skip ?? "", /^unsupported colour profile /);
});

test("colour: untagged, sRGB chunk, and gAMA 45455 with sRGB primaries pass through unchanged", () => {
  const plain = swatchImage(SWATCHES);
  for (const chunks of [[], [["sRGB", Buffer.from([0])]], [["gAMA", Buffer.from([0, 0, 0xb1, 0x8f])]]]) {
    const out = toSrgb(decodePng(encodePng(plain, chunks)));
    assert.equal(out.converted, false);
    assert.ok(out.image.data.equals(plain.data));
  }
});

test("colour: gAMA 1.0 (linear samples) is converted", () => {
  const gama = Buffer.alloc(4);
  gama.writeUInt32BE(100000);
  const { image, converted } = toSrgb(decodePng(encodePng(swatchImage([[128, 128, 128]]), [["gAMA", gama]])));
  assert.equal(converted, true);
  assert.ok(Math.abs(image.data[0] - 188) <= 1, `linear 0.5 is sRGB ~188, got ${image.data[0]}`);
});

test("colour: the system Display P3 profile parses as a matrix profile (macOS only)", { skip: !existsSync("/System/Library/ColorSync/Profiles/Display P3.icc") }, () => {
  const prof = parseIcc(readFileSync("/System/Library/ColorSync/Profiles/Display P3.icc"));
  assert.equal(prof.desc, "Display P3");
  assert.equal(prof.unsupported, undefined);
  const ours = parseIcc(displayP3Profile());
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.ok(Math.abs(prof.matrix[i][j] - ours.matrix[i][j]) < 1e-3);
});
