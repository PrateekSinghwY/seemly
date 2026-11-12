#!/usr/bin/env node
// frame_diff: Phase D for builds whose reference is unreachable ("verify against frames").
// When the reference can only be seen in recordings, the clone is checked against each
// state's canonical frame (states.json from the video mode) on three channels:
//
//   text       OCR the clone shot the same way as the frame; every label the frame shows
//              must be on the clone. Seeded values (numbers, dates, times, names) differ by
//              design and are ignored. A missing label is a defect.
//   layout     OCR word boxes matched between frame and clone; offset in CSS px per region,
//              after removing the global calibration offset. Median above 4 px for an atom
//              or 8 px for a region is a defect; both crops are saved side by side.
//   structure  the plan's spec (roles, names, counts, order: 7 columns means 7 columns)
//              against the clone's accessibility tree.
//
// Colour is never checked against a frame (video compression shifts it); tokens are checked
// against a live capture when one exists (seemly decisions: frames are the shot list).
// The reachable-reference paths (pixel oracle, two-tab compare) are unchanged.
//
//   node frame_diff.mjs --plan <frame_verify.json> [--out <dir>] [--only <state-id>]
//   node frame_diff.mjs --selftest            # planted defects: each must fail its channel
//
// Plan (one per build, in never_to_be_pushed/discovery/):
//   { "clone": "http://localhost:3000", "frames_root": "<dir with states.json, manifest.json,
//     frames_curated/>", "viewport": {"width": 1280, "height": 640},
//     "frame_crop": {"top": 80, "left": 0, "scale": 1},
//     "states": { "<screen_slug>#<state>": { "path": "/timecard", "steps": [{"click": "<selector>"}],
//        "regions": [{"name": "toolbar", "box": [x, y, w, h], "kind": "region|atom"}],
//        "structure": [{"role": "columnheader", "count": 7}, {"role": "button", "name": "Approve"},
//                      {"role": "tab", "order": ["Totals", "Accruals"]}],
//        "ignore_text": ["Regular"] } } }
// Outputs (local: crops hold frame pixels): <out>/<state-id>.md, <out>/crops/*.png,
// <out>/summary.json (pass per state and per checklist id, for the coverage report).
// Labels only: no OCR text from a frame is written except the label words compared.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { DISCOVERY, playwright } from "../lib/pw.mjs";

export const TOL = { atom: 4, region: 8 };
const MIN_CONF = 60;

// ---------------------------------------------------------------- OCR

// Small or light-on-dark UI text fails OCR at native size (a frame shown at 1.7x scored 0 of
// 13); both the frame and the clone are read from copies upscaled OCR_SCALE times, the same
// factor video_privacy.py uses.
export const OCR_SCALE = 2;

/** A copy of `png` upscaled `scale` times (ffmpeg, lanczos), in a temp dir; null if it fails. */
function upscaled(png, scale) {
  if (scale <= 1) return null;
  const dir = mkdtempSync(join(tmpdir(), "ocr-"));
  const out = join(dir, "big.png");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", png, "-vf", `scale=iw*${scale}:ih*${scale}:flags=lanczos`, out], { stdio: "ignore" });
    return { out, dir };
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

/** Words with boxes in the image's own pixels, via tesseract TSV at psm 11 on an upscaled
 * copy, the same call the video mode uses. */
export function ocr(png, scale = OCR_SCALE) {
  const big = upscaled(png, scale);
  const k = big ? scale : 1;
  let tsv;
  try {
    tsv = execFileSync("tesseract", [big ? big.out : png, "-", "--psm", "11", "tsv"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } finally {
    if (big) rmSync(big.dir, { recursive: true, force: true });
  }
  const words = [];
  for (const line of tsv.split("\n").slice(1)) {
    const c = line.split("\t");
    if (c.length !== 12 || !c[11].trim()) continue;
    const conf = Number(c[10]);
    const [x, y, w, h] = c.slice(6, 10).map((v) => Number(v) / k);
    words.push({ text: c[11].trim(), conf, x, y, w, h });
  }
  return words;
}

export const norm = (t) => t.toLowerCase().replace(/[^a-z]/g, "");

/** A label is a word of letters; values (digits, times, dates, money) differ by design. */
export function isLabel(w, ignore) {
  if (w.conf < MIN_CONF || /\d/.test(w.text)) return false;
  const n = norm(w.text);
  return n.length >= 3 && !ignore.has(n);
}

function editDistanceAtMost1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ---------------------------------------------------------------- channels

export function textChannel(frameWords, cloneWords, ignoreList = []) {
  const ignore = new Set(ignoreList.map(norm));
  const clone = new Set(cloneWords.filter((w) => isLabel(w, ignore)).map((w) => norm(w.text)));
  const want = new Map();
  for (const w of frameWords.filter((w) => isLabel(w, ignore))) want.set(norm(w.text), w);
  const missing = [];
  for (const [n, w] of want) {
    const found = clone.has(n) || (n.length >= 5 && [...clone].some((c) => editDistanceAtMost1(n, c)));
    if (!found) missing.push({ label: n, box: [w.x, w.y, w.w, w.h] });
  }
  return { pass: missing.length === 0, labels: want.size, missing };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Frame px -> clone CSS px: drop the browser chrome band, then scale to the viewport. */
export function toClone(box, crop) {
  const s = crop.scale ?? 1;
  return [(box[0] - (crop.left ?? 0)) * s, (box[1] - (crop.top ?? 0)) * s, box[2] * s, box[3] * s];
}

export function layoutChannel(frameWords, cloneWords, regions, crop, ignoreList = []) {
  const ignore = new Set(ignoreList.map(norm));
  const once = (ws) => {
    const by = new Map();
    for (const w of ws.filter((w) => isLabel(w, ignore))) {
      const n = norm(w.text);
      by.set(n, by.has(n) ? null : w);
    }
    return by;
  };
  const f = once(frameWords);
  const c = once(cloneWords);
  const pairs = [];
  for (const [n, fw] of f) {
    const cw = c.get(n);
    if (!fw || !cw) continue;
    const [fx, fy, fwid, fh] = toClone([fw.x, fw.y, fw.w, fw.h], crop);
    pairs.push({ n, dx: cw.x + cw.w / 2 - (fx + fwid / 2), dy: cw.y + cw.h / 2 - (fy + fh / 2), cw, fw });
  }
  // Calibration: a small global offset (recording vs viewport) is not a layout defect.
  const gx = median(pairs.map((p) => p.dx));
  const gy = median(pairs.map((p) => p.dy));
  const all = [...regions, { name: "page", box: [0, 0, 1e6, 1e6], kind: "region" }];
  const out = [];
  for (const r of all) {
    const [x, y, w, h] = r.box;
    const mine = pairs.filter((p) => {
      const cx = p.cw.x + p.cw.w / 2;
      const cy = p.cw.y + p.cw.h / 2;
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h && (r.name !== "page" || !p.claimed);
    });
    if (r.name !== "page") for (const p of mine) p.claimed = true;
    const d = mine.map((p) => Math.hypot(p.dx - gx, p.dy - gy));
    const tol = TOL[r.kind] ?? TOL.region;
    const med = median(d);
    out.push({
      name: r.name,
      kind: r.kind ?? "region",
      words: mine.length,
      median: +med.toFixed(1),
      max: +(d.length ? Math.max(...d) : 0).toFixed(1),
      tol,
      pass: med <= tol,
      box: r.box,
    });
  }
  return { pass: out.every((r) => r.pass), matched: pairs.length, calibration: [+gx.toFixed(1), +gy.toFixed(1)], regions: out };
}

export async function structureChannel(page, spec = []) {
  const rows = [];
  for (const s of spec) {
    const loc = s.name ? page.getByRole(s.role, { name: s.name, exact: true }) : page.getByRole(s.role);
    const count = await loc.count();
    const row = { role: s.role, name: s.name ?? null, want: s.count ?? (s.order ? s.order.length : ">=1"), got: count };
    row.pass = s.count != null ? count === s.count : count >= 1;
    if (s.order) {
      const names = await page
        .getByRole(s.role)
        .evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()));
      let k = 0;
      for (const n of names) if (k < s.order.length && n === s.order[k]) k++;
      row.order = k === s.order.length ? "in order" : `out of order (${names.slice(0, 8).join(", ")})`;
      row.pass &&= k === s.order.length;
    }
    rows.push(row);
  }
  return { pass: rows.every((r) => r.pass), rows };
}

// ---------------------------------------------------------------- crops (composited in the browser)

async function sideBySide(page, framePng, clonePng, frameBox, cloneBox, out) {
  const b64 = (p) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
  const data = await page.evaluate(
    async ({ a, b, fb, cb }) => {
      const load = (src) => new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.src = src;
      });
      const [fi, ci] = await Promise.all([load(a), load(b)]);
      const pad = 24;
      const box = (r) => [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), r[2] + 2 * pad, r[3] + 2 * pad];
      const F = box(fb);
      const C = box(cb);
      const h = Math.max(F[3], C[3]);
      const cv = document.createElement("canvas");
      cv.width = F[2] + C[2] + 8;
      cv.height = h;
      const g = cv.getContext("2d");
      g.fillStyle = "#f0f";
      g.fillRect(0, 0, cv.width, h);
      g.drawImage(fi, F[0], F[1], F[2], F[3], 0, 0, F[2], F[3]);
      g.drawImage(ci, C[0], C[1], C[2], C[3], F[2] + 8, 0, C[2], C[3]);
      return cv.toDataURL("image/png").split(",")[1];
    },
    { a: b64(framePng), b: b64(clonePng), fb: frameBox, cb: cloneBox },
  );
  writeFileSync(out, Buffer.from(data, "base64"));
}

/** Crop a box of a PNG (2x, optionally inverted) in the browser and write it to a file. */
async function cropPng(page, png, box, out, invert = false) {
  const data = await page.evaluate(
    async ({ src, b, inv }) => {
      const im = await new Promise((ok) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.src = src;
      });
      const pad = 16;
      const [x, y, w, h] = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), b[2] + 2 * pad, b[3] + 2 * pad];
      const cv = document.createElement("canvas");
      cv.width = w * 2;
      cv.height = h * 2;
      const g = cv.getContext("2d");
      if (inv) g.filter = "invert(1) grayscale(1)";
      g.drawImage(im, x, y, w, h, 0, 0, w * 2, h * 2);
      return cv.toDataURL("image/png").split(",")[1];
    },
    { src: `data:image/png;base64,${readFileSync(png).toString("base64")}`, b: box, inv: invert },
  );
  writeFileSync(out, Buffer.from(data, "base64"));
}

/** OCR misses light-on-dark text on one side and not the other. Before a label is called
 * missing, the clone is read again where the label should be: cropped, 2x, normal and inverted. */
async function recheckMissing(page, shot, text, crop, tmpDir) {
  const still = [];
  for (const m of text.missing) {
    const box = toClone(m.box, crop);
    box[0] -= 40;
    box[2] += 80;
    let seen = false;
    for (const inv of [false, true]) {
      const p = join(tmpDir, `recheck-${m.label}-${inv ? "i" : "n"}.png`);
      await cropPng(page, shot, box, p, inv);
      // the same upscale as ocr(): a small cropped label reads far better at OCR_SCALE
      const big = upscaled(p, OCR_SCALE);
      let words;
      try {
        words = execFileSync("tesseract", [big ? big.out : p, "-", "--psm", "7"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } finally {
        if (big) rmSync(big.dir, { recursive: true, force: true });
      }
      if (words.split(/\s+/).some((w) => norm(w) === m.label || (m.label.length >= 5 && editDistanceAtMost1(norm(w), m.label)))) {
        seen = true;
        break;
      }
    }
    if (!seen) still.push(m);
  }
  text.missing = still;
  text.pass = still.length === 0;
  return text;
}

// ---------------------------------------------------------------- one state

async function drive(page, base, st) {
  await page.goto(new URL(st.path ?? "/", base).href, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  for (const step of st.steps ?? []) {
    if (step.click) await page.locator(step.click).first().click();
    if (step.hover) await page.locator(step.hover).first().hover();
    if (step.press) await page.keyboard.press(step.press);
    if (step.fill) await page.locator(step.fill[0]).fill(step.fill[1]);
    await page.waitForTimeout(step.wait ?? 300);
  }
  await page.waitForTimeout(300);
}

export async function verifyState({ page, plan, id, st, frame, covers, outDir }) {
  mkdirSync(join(outDir, "crops"), { recursive: true });
  const safe = id.replace(/[^a-z0-9#-]/gi, "_").replace("#", "--");
  const shot = join(outDir, "crops", `${safe}--clone.png`);
  await drive(page, plan.clone, st);
  await page.screenshot({ path: shot });
  const crop = plan.frame_crop ?? {};
  const fw = ocr(frame);
  const cw = ocr(shot);
  // Crops are composited on a blank tab: a clone's CSP may refuse data: images.
  const scratch = await page.context().newPage();
  const tmpDir = mkdtempSync(join(tmpdir(), "frame-diff-recheck-"));
  const text = await recheckMissing(scratch, shot, textChannel(fw, cw, st.ignore_text), crop, tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
  const layout = layoutChannel(fw, cw, st.regions ?? [], crop, st.ignore_text);
  const structure = await structureChannel(page, st.structure);

  const crops = [];
  const unmap = (b) => {
    const s = crop.scale ?? 1;
    return [b[0] / s + (crop.left ?? 0), b[1] / s + (crop.top ?? 0), b[2] / s, b[3] / s];
  };
  for (const r of layout.regions.filter((r) => !r.pass && r.name !== "page")) {
    const p = join(outDir, "crops", `${safe}--${r.name}.png`);
    await sideBySide(scratch, frame, shot, unmap(r.box), r.box, p);
    crops.push({ what: `layout ${r.name}`, file: p });
  }
  for (const m of text.missing.slice(0, 5)) {
    const p = join(outDir, "crops", `${safe}--missing-${m.label}.png`);
    await sideBySide(scratch, frame, shot, m.box, toClone(m.box, crop), p);
    crops.push({ what: `missing label "${m.label}"`, file: p });
  }
  await scratch.close();
  const res = { id, pass: text.pass && layout.pass && structure.pass, text, layout, structure, crops, covers };
  writeFileSync(join(outDir, `${safe}.md`), report(res));
  return res;
}

function report(r) {
  const ok = (b) => (b ? "PASS" : "FAIL");
  const L = [
    `# frame_diff: ${r.id}`,
    "",
    `- **Verdict:** ${ok(r.pass)}`,
    `- **Proves:** ${r.covers.length ? r.covers.join(", ") : "no checklist id on this state"}`,
    "",
    "| channel | result | detail |",
    "|---|---|---|",
    `| text | ${ok(r.text.pass)} | ${r.text.labels} frame labels; missing: ${r.text.missing.map((m) => m.label).join(", ") || "none"} |`,
    `| layout | ${ok(r.layout.pass)} | ${r.layout.matched} words matched; calibration ${r.layout.calibration.join(", ")} px |`,
    `| structure | ${ok(r.structure.pass)} | ${r.structure.rows.filter((x) => !x.pass).map((x) => `${x.role}${x.name ? ` "${x.name}"` : ""}: want ${x.want}, got ${x.got}${x.order ? `, ${x.order}` : ""}`).join("; ") || "all rows match"} |`,
    "",
    "| region | kind | words | median px | max px | tol | result |",
    "|---|---|---|---|---|---|---|",
    ...r.layout.regions.map((g) => `| ${g.name} | ${g.kind} | ${g.words} | ${g.median} | ${g.max} | ${g.tol} | ${ok(g.pass)} |`),
  ];
  if (r.crops.length) L.push("", "Side by side (frame left, clone right):", "", ...r.crops.map((c) => `- ${c.what}: \`${c.file}\``));
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------- run a plan

export async function run(plan, outDir, only) {
  const root = plan.frames_root;
  const states = JSON.parse(readFileSync(join(root, "states.json"), "utf8")).states;
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const byId = new Map(manifest.frames.map((f) => [f.id, f]));
  const { chromium } = await playwright();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: plan.viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const results = [];
  try {
    for (const [id, st] of Object.entries(plan.states)) {
      if (only && id !== only) continue;
      const s = states[id];
      if (!s) {
        results.push({ id, pass: false, error: "state not in states.json" });
        continue;
      }
      const canon = byId.get(s.canonical[0]);
      const frame = join(root, "frames_curated", canon.video, canon.file);
      const covers = [...new Set(s.canonical.flatMap((c) => byId.get(c)?.covers ?? []))];
      results.push(await verifyState({ page, plan, id, st, frame, covers, outDir }));
    }
  } finally {
    await browser.close();
  }
  const checklist = {};
  for (const r of results) {
    for (const c of r.covers ?? []) {
      checklist[c] ??= { verified: false, states: [] };
      checklist[c].states.push(r.id);
      checklist[c].verified ||= r.pass;
    }
  }
  const summary = {
    generated: new Date().toISOString(),
    states: Object.fromEntries(results.map((r) => [r.id, { pass: r.pass, error: r.error ?? null,
      text: r.text?.pass, layout: r.layout?.pass, structure: r.structure?.pass }])),
    checklist,
  };
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return { results, summary };
}

// ---------------------------------------------------------------- selftest

/** The video selftest's fake app (header, list rows, tabs), as HTML with labels to read. */
export function fakeApp({ dropLabel = false, shift = 0, extraColumn = false, chrome = 0 } = {}) {
  const cols = ["Date", "Schedule", "Absence", "Shift", "Daily", "Period", ...(extraColumn ? ["Wages"] : [])];
  const rows = ["Monday", "Tuesday", "Wednesday", "Thursday"]
    .map((d, i) => `<tr><td>${d}</td><td>Morning</td><td></td><td>${8 + i}.00</td><td>${8 + i}.00</td><td>${40 + i}.00</td>${extraColumn ? "<td>0.00</td>" : ""}</tr>`)
    .join("");
  return `<!doctype html><html><head><style>
    body{margin:0;font:20px Arial,sans-serif;color:#111}
    .chrome{height:${chrome}px;background:#282828}
    header{height:60px;background:#3c3c46;color:#fff;display:flex;align-items:center;padding-left:24px;font-size:26px}
    .bar{display:flex;gap:16px;padding:16px 24px}
    button{width:150px;height:44px;font:20px Arial;background:#fff;border:2px solid #555}
    #approve{margin-left:${shift}px}
    table{border-collapse:collapse;table-layout:fixed;margin:8px 24px}
    th,td{width:150px;height:40px;border:1px solid #999;text-align:left;padding-left:8px}
    .tabs{display:flex;gap:40px;padding:20px 24px}
  </style></head><body><div class="chrome"></div>
  <header>Timecard</header>
  <div class="bar"><button id="approve">Approve</button><button>Refresh</button><button>${dropLabel ? "" : "Calculate"}</button></div>
  <table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
  <div class="tabs" role="tablist"><span role="tab">Totals</span><span role="tab">Accruals</span><span role="tab">Audits</span></div>
  </body></html>`;
}

async function selftest() {
  const { chromium } = await playwright();
  const tmp = mkdtempSync(join(tmpdir(), "frame-diff-"));
  const root = join(tmp, "07_video");
  mkdirSync(join(root, "frames_curated", "v"), { recursive: true });
  const browser = await chromium.launch();
  const CHROME = 80;
  // The "frame": the app recorded with a browser chrome band, saved lossy like a video still.
  const rec = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await rec.setContent(fakeApp({ chrome: CHROME }));
  const jpg = join(tmp, "frame.jpg");
  await rec.screenshot({ path: jpg, type: "jpeg", quality: 70 });
  const src = `data:image/jpeg;base64,${readFileSync(jpg).toString("base64")}`;
  await rec.setContent(`<body style="margin:0"><img src="${src}" style="display:block"></body>`);
  await rec.screenshot({ path: join(root, "frames_curated", "v", "f.png") });
  await browser.close();
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ frames: [{ id: "v@1", video: "v", file: "f.png", covers: ["S02.R2"] }] }));
  writeFileSync(join(root, "states.json"), JSON.stringify({ states: { "timecard#rest": { canonical: ["v@1"] } } }));

  const variants = [
    ["clean", {}, null],
    ["missing label", { dropLabel: true }, "text"],
    ["12 px shift", { shift: 12 }, "layout"],
    ["extra column", { extraColumn: true }, "structure"],
  ];
  let ok = true;
  console.log(`${"variant".padEnd(15)} text   layout structure  expected`);
  for (const [name, opts, expect] of variants) {
    const html = join(tmp, `${name.replace(/\W+/g, "-")}.html`);
    writeFileSync(html, fakeApp(opts));
    const plan = {
      clone: `file://${html}`,
      frames_root: root,
      viewport: { width: 1280, height: 640 },
      frame_crop: { top: CHROME },
      states: {
        "timecard#rest": {
          path: `file://${html}`,
          regions: [
            { name: "approve", box: [24, 76, 160, 48], kind: "atom" },
            { name: "toolbar", box: [0, 60, 1280, 76], kind: "region" },
          ],
          structure: [
            { role: "columnheader", count: 6 },
            { role: "button", count: 3 },
            { role: "tab", order: ["Totals", "Accruals", "Audits"] },
          ],
        },
      },
    };
    const out = join(tmp, "verify", name.replace(/\W+/g, "-"));
    mkdirSync(out, { recursive: true });
    const { results } = await run(plan, out);
    const r = results[0];
    const got = { text: r.text.pass, layout: r.layout.pass, structure: r.structure.pass };
    const good = expect === null ? Object.values(got).every(Boolean) : Object.entries(got).every(([k, v]) => v === (k !== expect));
    ok &&= good;
    const f = (b) => (b ? "pass" : "FAIL").padEnd(6);
    console.log(`${name.padEnd(15)} ${f(got.text)} ${f(got.layout)} ${f(got.structure)}    ${expect ? `${expect} fails` : "all pass"}  ${good ? "OK" : "WRONG"}`);
  }
  console.log(`\nFRAME_DIFF SELFTEST ${ok ? "PASS" : "FAIL"}`);
  if (process.env.FRAME_DIFF_KEEP) console.log(`kept: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
  return ok;
}

// ---------------------------------------------------------------- cli

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values: o } = parseArgs({
    options: {
      plan: { type: "string" },
      out: { type: "string" },
      only: { type: "string" },
      selftest: { type: "boolean", default: false },
    },
  });
  if (o.selftest) {
    process.exit((await selftest()) ? 0 : 1);
  }
  if (!o.plan) {
    console.error("usage: frame_diff.mjs --plan <frame_verify.json> [--out dir] [--only state] | --selftest");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(o.plan, "utf8"));
  const out = o.out ?? join(DISCOVERY, "verify");
  mkdirSync(out, { recursive: true });
  if (!existsSync(join(plan.frames_root, "states.json"))) {
    console.error(`no states.json in ${plan.frames_root}: run the video mode's states layer first`);
    process.exit(2);
  }
  const { results } = await run(plan, out, o.only);
  for (const r of results) {
    const ch = r.error ? r.error : `text ${r.text.pass ? "ok" : "FAIL"}, layout ${r.layout.pass ? "ok" : "FAIL"}, structure ${r.structure.pass ? "ok" : "FAIL"}`;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}: ${ch}`);
  }
  console.log(`wrote ${out}/summary.json`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
