#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=10", "imagehash>=4.3", "numpy>=1.26", "scikit-image>=0.22", "scipy>=1.11"]
# ///
"""Stage A2/A3: dedupe raw frames into curated frames and keep manifest.json in sync.

Run with uv (dependencies install themselves on first run):

    uv run $V/dedupe_frames.py dedupe [video-slug ...]     # A2: all extracted videos by default
    uv run $V/dedupe_frames.py rescue <slug> --from 01:12 --to 01:20   # A4: pull raw frames back in
    uv run $V/dedupe_frames.py rename [video-slug ...]     # A3: sync file names to manifest labels
    uv run $V/dedupe_frames.py report                      # counts per video
    uv run $V/dedupe_frames.py events <slug> --video <file>  # A1b: native-fps event frames
    uv run --with faster-whisper $V/dedupe_frames.py transcribe [slug ...]   # V1 speech
    uv run $V/dedupe_frames.py meta <slug> --rank real-tenant --mask-top 0.09  # V6, V9
    uv run $V/dedupe_frames.py states                      # after A3: seen, state, cross-video
    uv run $V/dedupe_frames.py pii-check                   # V6 blocking check, exit 1 on a hit
    uv run $V/dedupe_frames.py selftest                    # planted-event proof, nothing missed

Layers (VIDEO_SKILL_REQUIREMENTS V4, V10), each counted in the report:
  events     every decoded frame is analysed; settle / transient / pre frames are added
             to the pool so states shorter than the 2 fps sample interval survive
  settle     samples inside a short burst (page loading, animating) are dropped: the
             settle frame after the burst, stable for about 1 s, stands for them
  frame      the keep rules below (D-004, D-005), plus `revisit`: a frame identical to
             one of the last few kept frames (A -> B -> A) is not kept twice
  seen       a frame matching an already-labelled one inherits its labels
  state      same screen_slug + state = one canonical frame, the rest aliases
  cross      the same state from several videos = one state, several sources
  pin        sole evidence for a coverage-contract item is never merged away

Keep rules (a frame is kept if ANY reason fires; compared against the last kept frame):
  first          first frame of the video
  scene_change   ffmpeg scene score >= --scene-keep (0.25)
  chrome_band    strong change inside the top band (URL bar, breadcrumb, page title)
  visual_change  pHash distance > --phash-max (6) AND SSIM <= --ssim-min (0.96)
  local_change   a strong, non-cursor change that the global metrics miss:
                 modal, dropdown, toast, checkbox, validation message, fill state
Dropped otherwise: near-duplicates, cursor-only moves, faint hover tints.
Typing bursts in one field keep the first and the last frame of the burst.

Idempotent. Re-running never deletes a frame that has a human label in the manifest
or was rescued; those are pinned. Labels are keyed by frame id (<slug>@<t>).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from itertools import repeat
from dataclasses import dataclass, field
from pathlib import Path

import imagehash
import numpy as np
from PIL import Image
from skimage.measure import label as cc_label
from skimage.measure import regionprops
from skimage.metrics import structural_similarity

import video_events
import video_live
import video_paths
import video_privacy
import video_speech
import video_states
import video_storage

ROOT = video_paths.project()
VIDEO_ROOT = video_paths.video_root(
    ROOT
)  # see video_paths.py; the self-test points it at a temp tree
RAW_DIR = VIDEO_ROOT / "frames_raw"
CURATED_DIR = VIDEO_ROOT / "frames_curated"
MANIFEST = VIDEO_ROOT / "manifest.json"
STATES = VIDEO_ROOT / "states.json"  # tracked: ids and labels only
PII_PATH = RAW_DIR / "pii.json"  # local only (frames_raw is gitignored)
SEEN_PATH = RAW_DIR / "seen.json"  # local hash cache

# Fields a human (or a labelling session) fills in. Preserved across re-runs.
LABEL_FIELDS = (
    "module",
    "screen",
    "screen_slug",
    "flow",
    "flow_step",
    "entities_visible",
    "fields_visible",
    "state",
    "nav_path",
    "new_evidence",
    "notes",
    "frame_kind",  # V3: web-ui | mobile-ui | slide | mockup | person | other
    "look",  # V5: classic | new (web-ui only)
    "covers",  # V10 and the gap report: coverage-contract item ids this frame shows
    "conflicts",  # rows for gaps.md: [{"item": ..., "frame_says": ..., "doc_says": ...}]
)


@dataclass
class Params:
    phash_max: int = 6
    ssim_min: float = 0.96
    scene_keep: float = 0.25
    work_width: int = 1280
    strong_diff: int = 40
    min_change_px: int = 48
    cursor_px: int = 48
    band_frac: float = 0.12
    typing_frac: float = 0.004
    faint_diff: int = 8
    faint_area: float = 0.03
    burst_keep_s: float = 2.0  # settle layer: shorter bursts are represented by their settle frame
    revisit_window: int = 5  # frame layer: compare against this many recent kept frames


@dataclass
class Frame:
    file: str
    t: float
    source: str
    scene_score: float | None


@dataclass
class Kept:
    frame: Frame
    reasons: list[str]
    phash: str
    rgb: np.ndarray | None
    change_bbox: list[int] | None = None
    change_px: int = 0
    small_local: bool = False
    run_start: bool = True
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------- helpers


def fmt_ts(t: float) -> str:
    """mm-ss-cc (centiseconds), the curated filename timestamp."""
    cs = round(t * 100)
    m, rem = divmod(cs, 6000)
    s, c = divmod(rem, 100)
    return f"{m:02d}-{s:02d}-{c:02d}"


def parse_ts(text: str) -> float:
    parts = [float(p) for p in re.split(r"[:\-]", text)]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def frame_id(slug: str, t: float) -> str:
    return f"{slug}@{t:.3f}"


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "unlabeled"


def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        data.setdefault("videos", {})
        data.setdefault("frames", [])
        return data
    return {"version": 1, "videos": {}, "frames": []}


def save_manifest(data: dict) -> None:
    data["frames"].sort(key=lambda f: (f["video"], f["t"]))
    MANIFEST.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def label_default(name: str):
    if name.endswith("_visible") or name in ("covers", "conflicts"):
        return []
    return False if name == "new_evidence" else None


def has_label(entry: dict) -> bool:
    return any(entry.get(k) not in (None, "", [], False) for k in LABEL_FIELDS)


def read_frames(slug: str) -> list[Frame]:
    path = RAW_DIR / slug / "frames.csv"
    if not path.exists():
        sys.exit(f"{path} missing: run scripts/extract_frames.sh first")
    out = []
    with path.open() as fh:
        for row in csv.DictReader(fh):
            score = row.get("scene_score") or ""
            out.append(
                Frame(row["file"], float(row["t"]), row["source"], float(score) if score else None)
            )
    out.sort(key=lambda f: (f.t, 0 if f.source == "scene" else 1))
    return out


FEATURE_BATCH = 256  # frames decoded ahead of the comparison; bounds memory


def frame_features(path: Path, width: int) -> tuple[np.ndarray, str, int]:
    """One decode per frame: the perceptual hash of the full frame, the RGB copy at `width`,
    and the frame's own width. Runs in a worker pool: decoding 21,000 3024-wide PNGs twice
    each on one core took 40 minutes for one 47-minute video."""
    with Image.open(path) as im:
        ph = str(imagehash.phash(im))
        rgb = im.convert("RGB")
        full = rgb.width
        if rgb.width > width:
            rgb = rgb.resize((width, round(rgb.height * width / rgb.width)), Image.BILINEAR)
        return np.asarray(rgb, dtype=np.uint8), ph, full


def _features(raw: Path, frames: list[Frame], width: int):
    """(frame, rgb, phash, full width) in order, decoded by a pool a batch at a time."""
    with ProcessPoolExecutor(max_workers=video_privacy.ocr_workers()) as pool:
        for start in range(0, len(frames), FEATURE_BATCH):
            batch = frames[start : start + FEATURE_BATCH]
            paths = [raw / fr.file for fr in batch]
            for fr, (rgb, ph, full) in zip(
                batch, pool.map(frame_features, paths, repeat(width), chunksize=4)
            ):
                yield fr, rgb, imagehash.hex_to_hash(ph), full


def to_gray(rgb: np.ndarray) -> np.ndarray:
    return (rgb @ np.array([0.299, 0.587, 0.114])).astype(np.uint8)


def channel_diff(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Per-pixel max channel difference: sees hue changes that grayscale hides."""
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)


def strong_components(diff_map: np.ndarray, p: Params) -> list:
    diff = diff_map > p.strong_diff
    if not diff.any():
        return []
    lab = cc_label(diff, connectivity=2)
    return [r for r in regionprops(lab) if r.area >= p.min_change_px]


def bbox_of(regions: list) -> list[int]:
    ys0, xs0, ys1, xs1 = zip(*(r.bbox for r in regions), strict=True)
    return [min(xs0), min(ys0), max(xs1), max(ys1)]


def boxes_touch(a: list[int], b: list[int], pad: int = 24) -> bool:
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


# ---------------------------------------------------------------- dedupe


def is_revisit(recent: list[Kept], rgb: np.ndarray, ph: imagehash.ImageHash, p: Params) -> bool:
    """A -> B -> A: the frame equals one of the last few kept frames, so B's closing is
    recorded by the flow, not by a second copy of A."""
    for k in reversed(recent[-p.revisit_window :]):
        if k.rgb is None or k.rgb.shape != rgb.shape:
            continue
        dm = channel_diff(rgb, k.rgb)
        if TICKER is not None and TICKER.shape == dm.shape:
            dm[TICKER] = 0
        if ph - imagehash.hex_to_hash(k.phash) <= 2 and not strong_components(dm, p):
            return True
    return False


def decide(
    prev: Kept | None, fr: Frame, rgb: np.ndarray, ph: imagehash.ImageHash, p: Params, scale: float
):
    """Return (reasons, info) for frame `fr` against the last kept frame."""
    if prev is None:
        return ["first"], {}
    assert prev.rgb is not None, "only the latest kept frame keeps its pixels"
    reasons: list[str] = []
    if fr.scene_score is not None and fr.scene_score >= p.scene_keep:
        reasons.append("scene_change")
    if rgb.shape != prev.rgb.shape:
        return reasons + ["visual_change"], {}

    gray = to_gray(rgb)
    dist = ph - imagehash.hex_to_hash(prev.phash)
    ssim = structural_similarity(gray, to_gray(prev.rgb), data_range=255)
    dmap = channel_diff(rgb, prev.rgb)
    if TICKER is not None and TICKER.shape == dmap.shape:
        dmap[TICKER] = 0  # a clock or caret ticking on its own is not a UI event
    comps = strong_components(dmap, p)
    # Large-area faint change (theme/header recolour, page background): a page-level
    # event even when no pixel moves far. Hover tints are small-area and stay out.
    faint_frac = float((dmap > p.faint_diff).mean())
    cursor_box = p.cursor_px * scale
    # A moving pointer leaves exactly two pointer-sized blobs (where it was, where it is).
    cursor_only = len(comps) == 2 and all(
        (r.bbox[2] - r.bbox[0]) <= cursor_box and (r.bbox[3] - r.bbox[1]) <= cursor_box
        for r in comps
    )
    band_rows = int(gray.shape[0] * p.band_frac)
    if not cursor_only and any(r.bbox[0] < band_rows for r in comps):
        reasons.append("chrome_band")

    info: dict = {"phash_dist": int(dist), "ssim": round(float(ssim), 4)}
    info["faint_frac"] = round(faint_frac, 4)
    if (dist > p.phash_max and ssim <= p.ssim_min) or faint_frac >= p.faint_area:
        reasons.append("visual_change")
    elif comps and not cursor_only:
        reasons.append("local_change")
    if comps and not cursor_only:
        px = int(sum(r.area for r in comps))
        info["change_bbox"] = [round(v / scale) for v in bbox_of(comps)]
        info["change_px"] = px
        info["small_local"] = reasons == ["local_change"] and px < p.typing_frac * gray.size
    return reasons, info


TICKER: np.ndarray | None = None


def load_ticker(raw: Path, shape: tuple[int, int]) -> np.ndarray | None:
    path = raw / "ticker_mask.png"
    if not path.exists():
        return None
    with Image.open(path) as im:
        m = np.asarray(im.convert("L").resize((shape[1], shape[0]), Image.NEAREST)) > 0
    return m if m.any() else None


def dedupe_video(slug: str, p: Params, manifest: dict) -> dict:
    global TICKER
    raw = RAW_DIR / slug
    frames = read_frames(slug)
    TICKER = None
    kept: list[Kept] = []
    dropped_superseded = 0
    scale = 1.0

    revisit_dropped = 0
    todo = [
        fr
        for fr in frames
        if not video_events.settle_filter(raw, fr.t, fr.source, p.burst_keep_s)
    ]
    settle_dropped = len(frames) - len(todo)
    for fr, rgb, ph, full in _features(raw, todo, p.work_width):
        if not kept:
            scale = rgb.shape[1] / full
            TICKER = load_ticker(raw, rgb.shape[:2])
        prev = kept[-1] if kept else None
        reasons, info = decide(prev, fr, rgb, ph, p, scale)
        if not reasons:
            continue
        if reasons != ["first"] and is_revisit(kept[:-1], rgb, ph, p):
            revisit_dropped += 1
            continue
        k = Kept(
            fr,
            reasons,
            str(ph),
            rgb,
            change_bbox=info.get("change_bbox"),
            change_px=info.get("change_px", 0),
            small_local=bool(info.get("small_local")),
            extra={x: info[x] for x in ("phash_dist", "ssim", "faint_frac") if x in info},
        )
        # Typing burst: small change in the same place as the previous small change.
        # Keep the burst's first frame (empty -> partial) and its latest frame (final fill).
        if (
            prev is not None
            and k.small_local
            and prev.small_local
            and prev.change_bbox
            and k.change_bbox
            and boxes_touch(prev.change_bbox, k.change_bbox)
        ):
            k.run_start = False
            if not prev.run_start:
                kept.pop()
                dropped_superseded += 1
        kept.append(k)
        if len(kept) > p.revisit_window + 1:
            kept[
                -p.revisit_window - 2
            ].rgb = None  # decide() and is_revisit() read only recent pixels

    # ---- write curated set, preserving labels and pinned frames
    by_id = {e["id"]: e for e in manifest["frames"] if e["video"] == slug}
    out_dir = CURATED_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    new_entries: dict[str, dict] = {}

    for k in kept:
        fid = frame_id(slug, k.frame.t)
        old = by_id.get(fid, {})
        entry = {
            "id": fid,
            "video": slug,
            "t": round(k.frame.t, 3),
            "timestamp": fmt_ts(k.frame.t),
            "raw_file": k.frame.file,
            "source": k.frame.source,
            "keep_reasons": k.reasons,
            "scene_score": k.frame.scene_score,
            "phash": k.phash,
            "change_bbox": k.change_bbox,
            **k.extra,
        }
        for f in LABEL_FIELDS:
            entry[f] = old.get(f, label_default(f))
        for extra in ("masked", "labels_from"):
            if extra in old:
                entry[extra] = old[extra]
        new_entries[fid] = entry

    pinned = 0
    for fid, old in by_id.items():
        if fid in new_entries:
            continue
        if has_label(old) or "rescued" in old.get("keep_reasons", []):
            old.setdefault("keep_reasons", [])
            if "pinned" not in old["keep_reasons"]:
                old["keep_reasons"].append("pinned")
            new_entries[fid] = old
            pinned += 1

    for entry in new_entries.values():
        entry["file"] = curated_name(entry)
        src = raw / entry["raw_file"]
        dst = out_dir / entry["file"]
        if not dst.exists():
            video_storage.clone_file(src, dst)  # copy-on-write: no new blocks until masked

    wanted = {e["file"] for e in new_entries.values()}
    for f in out_dir.glob("*.png"):
        if f.name not in wanted:
            f.unlink()

    manifest["frames"] = [e for e in manifest["frames"] if e["video"] != slug] + list(
        new_entries.values()
    )
    vmeta = manifest["videos"].get(slug, {})
    privacy = video_privacy.mask_video(
        out_dir,
        list(new_entries.values()),
        float(vmeta.get("mask_top") or 0),
        video_privacy.load_terms(PII_PATH),
    )
    seen = video_states.seen_pass(list(new_entries.values()), SEEN_PATH, CURATED_DIR)

    meta_path = raw / "video_meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    reasons_hist: dict[str, int] = {}
    for e in new_entries.values():
        for r in e["keep_reasons"]:
            reasons_hist[r] = reasons_hist.get(r, 0) + 1
    summary = {
        "sha256_16": meta.get("sha256_16"),
        "duration_s": meta.get("duration_s"),
        "resolution": meta.get("resolution"),
        "raw_frames": len(frames),
        "curated_frames": len(new_entries),
        "survival_pct": round(100 * len(new_entries) / max(len(frames), 1), 2),
        "typing_frames_superseded": dropped_superseded,
        "pinned": pinned,
        "layers": {
            "pool": {
                s: sum(1 for f in frames if f.source == s)
                for s in sorted({f.source for f in frames})
            },
            "settle_dropped": settle_dropped,
            "frame_dropped": len(frames)
            - settle_dropped
            - len(kept)
            - dropped_superseded
            - revisit_dropped,
            "typing_superseded": dropped_superseded,
            "revisit_dropped": revisit_dropped,
            "kept": len(kept),
            "same_time_merged": len(kept) - len({frame_id(slug, k.frame.t) for k in kept}),
            "pinned": pinned,
            "seen_labels_reused": seen,
        },
        "privacy": privacy,
        "source_rank": vmeta.get("source_rank"),
        "mask_top": vmeta.get("mask_top"),
        "yt_id": vmeta.get("yt_id"),  # kept across re-runs, or tags lose [yt:<id>]
        "keep_reasons": reasons_hist,
        "params": p.__dict__,
    }
    manifest["videos"][slug] = summary
    (raw / "dedupe_report.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def curated_name(entry: dict) -> str:
    screen = entry.get("screen_slug") or (
        slugify(entry["screen"]) if entry.get("screen") else "unlabeled"
    )
    return f"{entry['video']}__{entry['timestamp']}__{screen}.png"


# ---------------------------------------------------------------- commands


def extracted_slugs(requested: list[str]) -> list[str]:
    if requested:
        return requested
    return sorted(d.name for d in RAW_DIR.iterdir() if (d / "frames.csv").exists())


def remask_pruned(slug: str, manifest: dict) -> None:
    """Raw frames were pruned after curation: the selection is final, so a re-run only
    re-applies the mask (new pii.json terms) to the curated frames."""
    entries = [e for e in manifest["frames"] if e["video"] == slug]
    vmeta = manifest["videos"].get(slug, {})
    privacy = video_privacy.mask_video(
        CURATED_DIR / slug,
        entries,
        float(vmeta.get("mask_top") or 0),
        video_privacy.load_terms(PII_PATH),
    )
    print(f"{slug}: raw pruned, selection kept; re-masked {privacy['frames_masked']} curated frames "
          f"(re-select: extract_frames.sh --force <video>)")


def cmd_dedupe(args, p: Params) -> None:
    manifest = load_manifest()
    rows = []
    for slug in extracted_slugs(args.videos):
        meta_path = RAW_DIR / slug / "video_meta.json"
        if meta_path.exists() and json.loads(meta_path.read_text()).get("raw_pruned"):
            remask_pruned(slug, manifest)
            save_manifest(manifest)
            continue
        video_live.video_started(slug)
        try:
            s = dedupe_video(slug, p, manifest)
        except Exception as e:
            video_live.video_failed(slug, e)
            raise
        video_live.video_done(slug, s)
        video_speech.frame_speech(
            RAW_DIR / slug, [f for f in manifest["frames"] if f["video"] == slug]
        )
        rows.append((slug, s))
        save_manifest(manifest)
    print_report(rows)
    if args.ocr:
        run_ocr([slug for slug, _ in rows], manifest)
    flag = [r for r in rows if not 2 <= r[1]["survival_pct"] <= 5]
    if flag:
        print("\nOutside the 2-5% target (not an error; check A4 before tuning):")
        for slug, s in flag:
            print(f"  {slug}: {s['survival_pct']}%")


def cmd_rescue(args) -> None:
    manifest = load_manifest()
    slug = args.video
    lo, hi = parse_ts(args.from_), parse_ts(args.to)
    existing = {e["id"] for e in manifest["frames"]}
    added = 0
    for fr in read_frames(slug):
        if not lo <= fr.t <= hi:
            continue
        if fr.source == "scene" and not args.include_scene:
            continue
        fid = frame_id(slug, fr.t)
        if fid in existing:
            continue
        entry = {
            "id": fid,
            "video": slug,
            "t": round(fr.t, 3),
            "timestamp": fmt_ts(fr.t),
            "raw_file": fr.file,
            "keep_reasons": ["rescued"],
            "scene_score": fr.scene_score,
            "phash": None,
            "change_bbox": None,
        }
        for f in LABEL_FIELDS:
            entry[f] = label_default(f)
        entry["file"] = curated_name(entry)
        (CURATED_DIR / slug).mkdir(parents=True, exist_ok=True)
        if not (RAW_DIR / slug / fr.file).exists():  # raw was pruned: rebuild this window
            video_storage.restore_raw(slug, lo, hi, args.include_scene)
        video_storage.clone_file(RAW_DIR / slug / fr.file, CURATED_DIR / slug / entry["file"])
        manifest["frames"].append(entry)
        added += 1
    if slug in manifest["videos"]:
        manifest["videos"][slug]["curated_frames"] = sum(
            1 for e in manifest["frames"] if e["video"] == slug
        )
    save_manifest(manifest)
    print(f"rescued {added} frames from {slug} [{args.from_} .. {args.to}]")


def cmd_rename(args) -> None:
    manifest = load_manifest()
    slugs = set(args.videos) if args.videos else None
    moved = 0
    for e in manifest["frames"]:
        if slugs and e["video"] not in slugs:
            continue
        if e.get("screen") and not e.get("screen_slug"):
            e["screen_slug"] = slugify(e["screen"])
        want = curated_name(e)
        if want != e.get("file"):
            src = CURATED_DIR / e["video"] / e["file"]
            if src.exists():
                src.rename(CURATED_DIR / e["video"] / want)
            e["file"] = want
            moved += 1
    save_manifest(manifest)
    print(f"renamed {moved} curated frames to match manifest labels")


def cmd_report(_args) -> None:
    manifest = load_manifest()
    print_report(sorted(manifest["videos"].items()))
    frames = manifest["frames"]
    labeled = sum(1 for e in frames if e.get("screen"))
    new_ev = sum(1 for e in frames if e.get("new_evidence"))
    print(f"\nlabelled {labeled}/{len(frames)} curated frames; new_evidence flagged on {new_ev}")


def print_report(rows) -> None:
    print(f"{'video':40} {'raw':>7} {'curated':>8} {'kept%':>6}  reasons")
    tr = tc = 0
    for slug, s in rows:
        tr += s["raw_frames"]
        tc += s["curated_frames"]
        reasons = ", ".join(f"{k}={v}" for k, v in sorted(s["keep_reasons"].items()))
        print(
            f"{slug[:40]:40} {s['raw_frames']:>7} {s['curated_frames']:>8} {s['survival_pct']:>6}  {reasons}"
        )
    if len(rows) > 1:
        print(f"{'TOTAL':40} {tr:>7} {tc:>8} {round(100 * tc / max(tr, 1), 2):>6}")
    for slug, s in rows:
        lay = s.get("layers")
        if lay:
            print(
                f"  {slug[:38]} layers: pool {lay['pool']}; settle -{lay['settle_dropped']}, "
                f"frame -{lay['frame_dropped']}, typing -{lay['typing_superseded']}, "
                f"revisit -{lay['revisit_dropped']}; kept {lay['kept']}, pinned {lay['pinned']}, "
                f"seen {lay['seen_labels_reused']}"
            )
        if s.get("source_rank") == "real-tenant" and not s.get("mask_top"):
            print(
                f"  WARNING {slug}: real-tenant video with no chrome mask: "
                f"run `dedupe_frames.py meta {slug} --mask-top <fraction>` before labelling"
            )


def cmd_events(args) -> None:
    p = video_events.EventParams(
        **{k: getattr(args, k) for k in video_events.EventParams().__dict__}
    )
    r = video_events.run(args.video_slug, Path(args.video), RAW_DIR, p)
    c = r["picks"]
    print(
        f"  events {args.video_slug}: {r['video']['decoded_frames']} frames at {r['video']['fps']} fps; "
        f"{r['stable_runs']} stable runs, {len(r['bursts'])} bursts; "
        f"+{c['settle']} settle, +{c['transient']} transient, +{c['pre']} pre"
    )


def cmd_transcribe(args) -> None:
    manifest = load_manifest()
    for slug in extracted_slugs(args.videos):
        d = video_speech.run(
            RAW_DIR / slug, model=args.model, language=args.language, force=args.force
        )
        n = video_speech.frame_speech(
            RAW_DIR / slug, [f for f in manifest["frames"] if f["video"] == slug]
        )
        status = f"{len(d['segments'])} segments ({d['source']})" + (
            f"; {d['note']}" if d["note"] else ""
        )
        print(
            f"transcribe {slug}: {status}; merged {d['merged_repeats']} repeats; "
            f"speech attached to {n} curated frames -> frames_raw/{slug}/transcript.txt"
        )


def cmd_meta(args) -> None:
    manifest = load_manifest()
    v = manifest["videos"].setdefault(args.video, {})
    if args.rank:
        v["source_rank"] = args.rank
    if args.mask_top is not None:
        v["mask_top"] = args.mask_top
    if args.yt_id:
        v["yt_id"] = args.yt_id  # evidence tags become [yt:<id>@mm:ss]
    save_manifest(manifest)
    print(f"{args.video}: source_rank={v.get('source_rank')} mask_top={v.get('mask_top')} yt_id={v.get('yt_id')}")
    if args.mask_top is not None and (CURATED_DIR / args.video).exists():
        frames = [f for f in manifest["frames"] if f["video"] == args.video]
        r = video_privacy.mask_video(
            CURATED_DIR / args.video, frames, args.mask_top, video_privacy.load_terms(PII_PATH)
        )
        save_manifest(manifest)
        print(f"  masked {r['frames_masked']} curated frames, {r['pii_boxes']} pii boxes")


def cmd_states(_args) -> None:
    manifest = load_manifest()
    frames = manifest["frames"]
    reused = video_states.seen_pass(frames, SEEN_PATH, CURATED_DIR)
    rank = {k: v.get("source_rank") or "" for k, v in manifest["videos"].items()}
    states, report = video_states.states_pass(frames, rank)
    video_live.states(states)
    save_manifest(manifest)
    STATES.write_text(
        json.dumps({"version": 1, "report": report, "states": states}, indent=2) + "\n"
    )
    print(f"seen: {reused} frames reused labels from an earlier frame")
    print("state layer: " + ", ".join(f"{k}={v}" for k, v in report.items()))
    unclassified = sum(1 for f in frames if f.get("screen") and not f.get("frame_kind"))
    if unclassified:
        print(
            f"  {unclassified} labelled frames have no frame_kind (V3): label them before the gap report"
        )


def cmd_pii_check(_args) -> None:
    hits = video_privacy.check(ROOT, PII_PATH)
    if not video_privacy.load_terms(PII_PATH):
        print(f"pii-check: no terms in {PII_PATH.relative_to(ROOT)} (nothing to check)")
        return
    if hits:
        print("pii-check FAILED: a term from pii.json is in a file git would commit:")
        for h in hits:
            print(f"  {h}")
        sys.exit(1)
    print("pii-check: clean")


def cmd_selftest(args) -> None:
    import video_selftest

    sys.exit(video_selftest.main(keep=args.keep, speech=args.speech))


def run_ocr(slugs: list[str], manifest: dict) -> None:
    """OCR goes to frames_raw (gitignored): it is a search aid and may contain personal data."""
    if not shutil.which("tesseract"):
        print("tesseract not found; skipping OCR (brew install tesseract)")
        return
    for slug in slugs:
        rows = [e for e in manifest["frames"] if e["video"] == slug]
        with ProcessPoolExecutor(max_workers=video_privacy.ocr_workers()) as pool:
            texts = pool.map(
                video_privacy.ocr_text, [CURATED_DIR / slug / e["file"] for e in rows], chunksize=4
            )
            lines = [
                f"{e['id']}\t{e['timestamp']}\t{' '.join(txt.split())}"
                for e, txt in zip(rows, texts)
            ]
        (RAW_DIR / slug / "ocr.tsv").write_text("\n".join(lines) + "\n")
        print(f"ocr {slug}: {len(lines)} frames -> frames_raw/{slug}/ocr.tsv")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("dedupe", help="A2: raw -> curated + manifest")
    d.add_argument("videos", nargs="*")
    d.add_argument("--ocr", action="store_true", help="also write frames_raw/<slug>/ocr.tsv")
    defaults = Params()
    for name, val in defaults.__dict__.items():
        d.add_argument(f"--{name.replace('_', '-')}", type=type(val), default=val)

    r = sub.add_parser("rescue", help="A4: copy raw frames in a time range into curated")
    r.add_argument("video")
    r.add_argument("--from", dest="from_", required=True, help="mm:ss[.cc]")
    r.add_argument("--to", required=True, help="mm:ss[.cc]")
    r.add_argument(
        "--include-scene",
        action="store_true",
        help="also take scene candidates, not only 2fps samples",
    )

    n = sub.add_parser("rename", help="A3: rename curated files from manifest screen labels")
    n.add_argument("videos", nargs="*")

    sub.add_parser("report", help="print counts per video")

    ev = sub.add_parser("events", help="A1b: native-fps event frames (called by extract_frames.sh)")
    ev.add_argument("video_slug")
    ev.add_argument("--video", required=True, help="path to the video file")
    for name, val in video_events.EventParams().__dict__.items():
        ev.add_argument(f"--{name.replace('_', '-')}", type=type(val), default=val)

    t = sub.add_parser("transcribe", help="V1: subtitles if present, else local speech-to-text")
    t.add_argument("videos", nargs="*")
    t.add_argument(
        "--model", default="base", help="faster-whisper model: tiny, base, small, medium"
    )
    t.add_argument("--language", default=None, help="force a language code, e.g. en")
    t.add_argument("--force", action="store_true")

    m = sub.add_parser("meta", help="V6/V9: per-video source rank and browser-chrome mask")
    m.add_argument("video")
    m.add_argument("--rank", choices=sorted(video_states.SOURCE_RANK))
    m.add_argument(
        "--mask-top", type=float, default=None, help="fraction of height to fill, e.g. 0.09"
    )
    m.add_argument("--yt-id", default=None, help="public tutorial id, for [yt:<id>@mm:ss] tags")

    sub.add_parser("states", help="after A3 labels: seen cache, state and cross-video layers")
    sub.add_parser("pii-check", help="V6: fail if a pii.json term is in a file git would commit")
    st = sub.add_parser(
        "selftest", help="synthetic video with planted events: prove nothing is missed"
    )
    st.add_argument("--keep", action="store_true", help="keep the temp tree for inspection")
    st.add_argument(
        "--speech", action="store_true", help="also test speech-to-text (downloads a model)"
    )

    args = ap.parse_args()
    if args.cmd in ("dedupe", "states"):
        video_live.init(RAW_DIR)  # run.mjs watch --dir <frames_raw>/_live
    handlers = {
        "events": cmd_events,
        "transcribe": cmd_transcribe,
        "meta": cmd_meta,
        "states": cmd_states,
        "pii-check": cmd_pii_check,
        "selftest": cmd_selftest,
    }
    if args.cmd in handlers:
        handlers[args.cmd](args)
        return
    if args.cmd == "dedupe":
        p = Params(**{k: getattr(args, k) for k in defaults.__dict__})
        cmd_dedupe(args, p)
    elif args.cmd == "rescue":
        cmd_rescue(args)
    elif args.cmd == "rename":
        cmd_rename(args)
    else:
        cmd_report(args)


if __name__ == "__main__":
    main()
