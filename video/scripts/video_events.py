"""Native-frame-rate event pass for dedupe_frames.py (Stage A1b; VIDEO_SKILL_REQUIREMENTS V4).

A recording is mostly still; information arrives as events. Sampling at a fixed rate
misses short states (a 200 ms tooltip, a 400 ms spinner), so this pass looks at EVERY
decoded frame at low resolution, splits the timeline into stable runs and moving
bursts, and extracts, at full resolution, the frames each event needs:

  settle     a run stable for >= settle_s: one frame once it has settled (loaded page)
  transient  a run stable for >= min_state_s but < settle_s: its middle frame
             (tooltip, spinner, validation flash, a toast that is still animating)
  pre        the last frame of a stable run before a burst: where the pointer was
             when the change started (the action's evidence)

A frame counts as "moving" when, against the previous frame OR against the first frame
of the current run (so slow fades accumulate), it has a changed region larger than a
pointer, or more than two changed regions. A pointer moving alone leaves at most two
pointer-sized blobs and never breaks a stable run.

Writes, under frames_raw/<slug>/ (gitignored): e_%06d.png, events.json, and appends the
new frames to frames.csv with source settle | transient | pre.
"""

from __future__ import annotations

import csv
import json
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from skimage.measure import label as cc_label
from skimage.measure import regionprops


@dataclass
class EventParams:
    signal_width: int = 320  # analysis width; frames are kept at full resolution
    diff_thr: int = 18  # grey-level change that counts as a changed pixel
    min_region_px: int = 3  # smaller changed regions are compression noise
    cursor_px: int = 48  # pointer size at 1280 px wide; scaled to signal_width
    settle_s: float = 1.0  # owner rule: keep one frame after about 1 s stable
    min_state_s: float = 0.1  # shorter stable runs are animation frames
    burst_keep_s: float = 2.0  # bursts at least this long keep their samples (scroll, video)
    ticker_frac: float = 0.25  # a pixel changing in >= this share of seconds is a ticker
    ticker_max_area: float = 0.05  # ...unless that would mask more than this share of the frame


def probe(video: Path) -> dict:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,r_frame_rate",
            "-of",
            "json",
            str(video),
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    s = json.loads(out)["streams"][0]
    num, den = (s.get("avg_frame_rate") or "0/1").split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    return {"width": int(s["width"]), "height": int(s["height"]), "fps": round(fps, 3)}


def _pts_times(log: Path) -> list[float]:
    times = []
    for line in log.read_text(errors="replace").splitlines():
        if "Parsed_showinfo" in line and " n:" in line and "pts_time:" in line:
            times.append(float(line.split("pts_time:")[1].split()[0]))
    return times


def _decode_gray(video: Path, w: int, h: int, log: Path | None = None):
    with log.open("w") if log else open("/dev/null", "w") as err:
        proc = subprocess.Popen(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "info",
                "-i",
                str(video),
                "-vf",
                f"scale={w}:{h},format=gray,showinfo",
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=err,
        )
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(w * h)
            if len(buf) < w * h:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w).astype(np.int16)
        proc.wait()


def ticker_mask(video: Path, w: int, h: int, fps: float, p: EventParams) -> np.ndarray:
    """Pixels that keep changing on their own: a taskbar clock, a blinking caret, a webcam
    inset. Changing in >= ticker_frac of the video's seconds marks a pixel; the mask is
    dropped if it would cover more than ticker_max_area (real content is never masked)."""
    per_sec = max(1, round(fps or 30))
    seconds = np.zeros((h, w), dtype=np.int32)
    this_sec = np.zeros((h, w), dtype=bool)
    prev = None
    n_sec = 0
    for i, cur in enumerate(_decode_gray(video, w, h)):
        if prev is not None:
            this_sec |= np.abs(cur - prev) > p.diff_thr
        prev = cur
        if (i + 1) % per_sec == 0:
            seconds += this_sec
            this_sec[:] = False
            n_sec += 1
    if n_sec < 20:
        return np.zeros((h, w), dtype=bool)  # too short to tell a ticker from content
    mask = seconds >= p.ticker_frac * n_sec
    if mask.any():
        from scipy.ndimage import binary_dilation

        mask = binary_dilation(mask, iterations=2)
    if mask.mean() > p.ticker_max_area:
        return np.zeros((h, w), dtype=bool)
    return mask


def _moving(
    diff: np.ndarray, p: EventParams, cursor_box: float, ignore: np.ndarray | None = None
) -> bool:
    mask = diff > p.diff_thr
    if ignore is not None:
        mask &= ~ignore
    if not mask.any():
        return False
    regions = [r for r in regionprops(cc_label(mask, connectivity=2)) if r.area >= p.min_region_px]
    if not regions:
        return False
    pointer_only = len(regions) <= 2 and all(
        (r.bbox[2] - r.bbox[0]) <= cursor_box and (r.bbox[3] - r.bbox[1]) <= cursor_box
        for r in regions
    )
    return not pointer_only


def signal(
    video: Path, p: EventParams, out: Path | None = None
) -> tuple[list[float], list[bool], dict]:
    """Decode every frame at signal_width grey; return pts times and a moving flag per frame."""
    info = probe(video)
    w = p.signal_width
    h = max(2, round(info["height"] * w / info["width"] / 2) * 2)
    cursor_box = p.cursor_px * w / 1280
    ignore = ticker_mask(video, w, h, info["fps"], p)
    info["ticker_mask_px"] = int(ignore.sum())
    if out is not None:
        from PIL import Image

        Image.fromarray((ignore * 255).astype(np.uint8)).save(out / "ticker_mask.png")
    with tempfile.NamedTemporaryFile(suffix=".log", delete=False) as lf:
        log = Path(lf.name)
    prev = anchor = None
    moving: list[bool] = []
    for cur in _decode_gray(video, w, h, log):
        if prev is None:
            moving.append(False)
            anchor = cur
        else:
            assert anchor is not None
            m = _moving(np.abs(cur - prev), p, cursor_box, ignore) or _moving(
                np.abs(cur - anchor), p, cursor_box, ignore
            )
            moving.append(m)
            if m:
                anchor = cur  # a new run starts from here
        prev = cur
    times = _pts_times(log)
    log.unlink(missing_ok=True)
    n = min(len(times), len(moving))
    info["decoded_frames"] = n
    return times[:n], moving[:n], info


def segment(times: list[float], moving: list[bool], p: EventParams, fps: float):
    """Split into runs; pick the frame indices to extract. Returns (runs, picks)."""
    frame_dur = 1.0 / fps if fps else 0.0
    runs: list[dict] = []
    i = 0
    n = len(times)
    while i < n:
        j = i
        # a run of stable frames, or a burst of moving ones
        if moving[i]:
            while j + 1 < n and moving[j + 1]:
                j += 1
            kind = "burst"
        else:
            while j + 1 < n and not moving[j + 1]:
                j += 1
            kind = "stable"
        runs.append({"kind": kind, "i0": i, "i1": j, "t0": times[i], "t1": times[j] + frame_dur})
        i = j + 1

    picks: dict[int, str] = {}
    for k, r in enumerate(runs):
        if r["kind"] != "stable":
            continue
        d = r["t1"] - r["t0"]
        if d >= p.settle_s:
            target = r["t0"] + p.settle_s
            idx = next((x for x in range(r["i0"], r["i1"] + 1) if times[x] >= target), r["i1"])
            picks[idx] = "settle"
        elif d >= p.min_state_s:
            picks[(r["i0"] + r["i1"]) // 2] = "transient"
        followed = k + 1 < len(runs) and runs[k + 1]["kind"] == "burst"
        if followed and d >= p.min_state_s and r["i1"] not in picks:
            picks[r["i1"]] = "pre"
    return runs, picks


def extract(video: Path, out: Path, indices: list[int]) -> list[str]:
    """Write the chosen decoded frames as e_%06d.png, in index order; return file names.

    One decode pass at full resolution, saving only the picked indices. (A select
    expression with hundreds of terms exceeds ffmpeg's expression parser.)"""
    from PIL import Image

    for old in out.glob("e_*.png"):
        old.unlink()
    if not indices:
        return []
    info = probe(video)
    w, h = info["width"], info["height"]
    size = w * h * 3
    want = set(indices)
    last = max(indices)
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,  # we stop reading after the last pick
    )
    assert proc.stdout is not None
    files: list[str] = []
    n = 0
    while n <= last:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        if n in want:
            name = f"e_{len(files) + 1:06d}.png"
            Image.frombuffer("RGB", (w, h), buf, "raw", "RGB", 0, 1).save(
                out / name, compress_level=1
            )
            files.append(name)
        n += 1
    proc.stdout.close()
    proc.kill()
    proc.wait()
    if len(files) != len(indices):
        raise SystemExit(f"event extraction wrote {len(files)} frames for {len(indices)} picks")
    return files


def run(slug: str, video: Path, raw_dir: Path, p: EventParams) -> dict:
    out = raw_dir / slug
    csv_path = out / "frames.csv"
    if not csv_path.exists():
        raise SystemExit(f"{csv_path} missing: run scripts/extract_frames.sh first")
    times, moving, info = signal(video, p, out)
    runs, picks = segment(times, moving, p, info["fps"] or 30.0)
    order = sorted(picks)
    files = extract(video, out, order)

    rows = [
        r
        for r in csv.DictReader(csv_path.open())
        if r["source"] not in ("settle", "transient", "pre")
    ]
    for idx, name in zip(order, files, strict=False):
        rows.append(
            {"file": name, "t": f"{times[idx]:.3f}", "source": picks[idx], "scene_score": ""}
        )
    rows.sort(key=lambda r: float(r["t"]))
    with csv_path.open("w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=["file", "t", "source", "scene_score"])
        wr.writeheader()
        wr.writerows(rows)

    bursts = [
        {"t0": round(r["t0"], 3), "t1": round(r["t1"], 3)} for r in runs if r["kind"] == "burst"
    ]
    stables = [r for r in runs if r["kind"] == "stable"]
    counts = {k: sum(1 for v in picks.values() if v == k) for k in ("settle", "transient", "pre")}
    report = {
        "video": info,
        "params": asdict(p),
        "stable_runs": len(stables),
        "bursts": bursts,
        "picks": counts,
        "events": [
            {"t": round(times[i], 3), "kind": picks[i], "file": f}
            for i, f in zip(order, files, strict=False)
        ],
    }
    (out / "events.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def settle_filter(raw_slug_dir: Path, t: float, source: str, burst_keep_s: float) -> bool:
    """True when a sample/scene frame sits inside a short burst (loading, animating): the
    settle frame after the burst stands for it (settle layer)."""
    if source not in ("sample", "scene"):
        return False
    ev = raw_slug_dir / "events.json"
    if not ev.exists():
        return False
    for b in _bursts(ev):
        if b["t0"] < t < b["t1"] and (b["t1"] - b["t0"]) < burst_keep_s:
            return True
    return False


_BURST_CACHE: dict[Path, list[dict]] = {}


def _bursts(ev: Path) -> list[dict]:
    if ev not in _BURST_CACHE:
        _BURST_CACHE[ev] = json.loads(ev.read_text()).get("bursts", [])
    return _BURST_CACHE[ev]
