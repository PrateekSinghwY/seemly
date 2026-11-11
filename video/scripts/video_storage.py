#!/usr/bin/env python3
"""Storage guard for seemly-video builds. Standard library only; run with python3.

A video build stores three kinds of bulk, and each one has a single owner:

  the video          the source. Everything below can be regenerated from it.
  raw frames         a cache of the video. Needed by dedupe and rescue, then pruned.
  test databases     a throwaway per test run. Cloned copy-on-write, deleted on exit,
                     and swept here when a run was killed before it could clean up.

Commands (run from the project root):

  python3 $V/video_storage.py audit              # where the bytes are; exit 1 on a leak
  python3 $V/video_storage.py clean [--dry-run]  # delete leaked test DBs and scratch copies
  python3 $V/video_storage.py prune-raw [slug..] # drop raw PNGs once curated (video kept)
  python3 $V/video_storage.py restore <slug> --from mm:ss --to mm:ss   # raw frames back
  python3 $V/video_storage.py clone <src> <dst>  # copy-on-write copy (DB files, frames)
  python3 $V/video_storage.py check-tests [dir]  # fail on test code that leaks DB copies
  python3 $V/video_storage.py preflight <video>  # refuse an extraction the disk cannot hold
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import video_paths

MB = 1 << 20
GB = 1 << 30
DB_MIN = 50 * MB  # a database file this large in a temp root is a copy of a seeded DB
DB_SUFFIXES = (".db", ".sqlite", ".sqlite3", ".db-wal")
RAW_PREFIXES = (
    "f_",
    "s_",
    "e_",
)  # sample, scene and event frames; ticker_mask.png stays
RAW_PER_VIDEO_BYTE = (
    40  # raw frames measured at ~29x the video size; 40x leaves headroom
)
FREE_FLOOR = 20 * GB  # never let an extraction or a test run take the disk below this


# ------------------------------------------------------------------ helpers


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


def tree_size(path: Path) -> int:
    """Allocated bytes under path (st_blocks, so sparse and cloned files are not overcounted
    for the file itself; clones still count once per copy, as `du` does)."""
    if path.is_file():
        st = path.stat()
        return getattr(st, "st_blocks", 0) * 512 or st.st_size
    total = 0
    for root, dirs, files in os.walk(path, onerror=lambda e: None):
        for name in files:
            try:
                st = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            total += getattr(st, "st_blocks", 0) * 512 or st.st_size
    return total


def newest_mtime(path: Path) -> float:
    if path.is_file():
        return path.stat().st_mtime
    newest = path.stat().st_mtime
    for root, _dirs, files in os.walk(path, onerror=lambda e: None):
        for name in files:
            try:
                newest = max(newest, os.lstat(os.path.join(root, name)).st_mtime)
            except OSError:
                pass
    return newest


def free_bytes(path: Path) -> int:
    probe = path
    while not probe.exists():
        probe = probe.parent
    return shutil.disk_usage(probe).free


def temp_roots() -> list[Path]:
    """Every place a test run or an agent session writes throwaway files."""
    seen: list[Path] = []
    for p in (tempfile.gettempdir(), os.environ.get("TMPDIR"), "/tmp", "/var/tmp"):
        if not p:
            continue
        rp = Path(p).resolve()
        if rp.is_dir() and rp not in seen:
            seen.append(rp)
    return seen


def open_paths() -> set[str]:
    """Every file some process holds open right now. One lsof call, not one per candidate."""
    if not shutil.which("lsof"):
        return set()
    out = subprocess.run(
        ["lsof", "-n", "-w", "-F", "n"], capture_output=True, text=True, check=False
    )
    return {line[1:] for line in out.stdout.splitlines() if line.startswith("n/")}


def in_use(path: Path, opened: set[str]) -> bool:
    prefix = str(path.resolve())
    alt = prefix.removeprefix(
        "/private"
    )  # macOS reports /var and /private/var both ways
    return any(o.startswith((prefix, alt)) for o in opened)


# ------------------------------------------------------------------ clone


def clone_file(src: Path, dst: Path) -> str:
    """Copy-on-write when the filesystem allows it (APFS clonefile, Btrfs/XFS reflink):
    instant, and no new blocks until one side is written. Falls back to a real copy.
    Returns "clone" or "copy" so a caller can report which one it got."""
    src, dst = Path(src), Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    attempts = (
        [["cp", "-c", str(src), str(dst)]]
        if sys.platform == "darwin"
        else [["cp", "--reflink=always", str(src), str(dst)]]
    )
    for cmd in attempts:
        if subprocess.run(cmd, capture_output=True, check=False).returncode == 0:
            return "clone"
    shutil.copy2(src, dst)
    return "copy"


def clone_db(src: Path, dst: Path) -> str:
    """Clone a SQLite file plus its -wal, so the copy holds what the source holds."""
    how = clone_file(src, dst)
    wal = Path(f"{src}-wal")
    if wal.exists():
        clone_file(wal, Path(f"{dst}-wal"))
    return how


# ------------------------------------------------------------------ audit / clean


def find_leaks(min_age_s: float) -> list[tuple[Path, int, str]]:
    """Test DB directories and stray DB copies in temp roots, plus repo copies that carry a
    video tree. Each entry: (path, bytes, kind). Nothing outside temp roots is ever listed."""
    now = time.time()
    found: dict[Path, tuple[int, str]] = {}
    for root in temp_roots():
        for dirpath, dirs, files in os.walk(root, onerror=lambda e: None):
            d = Path(dirpath)
            depth = len(d.relative_to(root).parts)
            if depth > 6:
                dirs[:] = []
                continue
            # a repo copy: a project tree with a video tree inside it, copied for a test run
            if (
                d != root
                and (d / "docs" / "research").is_dir()
                and any(d.glob("docs/research/*/07_video/frames_raw"))
            ):
                found[d] = (0, "repo copy with video frames")
                dirs[:] = []
                continue
            for name in files:
                if not name.endswith(DB_SUFFIXES):
                    continue
                f = d / name
                try:
                    if f.stat().st_size < DB_MIN:
                        continue
                except OSError:
                    continue
                # a dir directly in a temp root holding a big DB is a test fixture dir
                owner = d if d.parent == root else f
                kind = "test DB dir" if owner == d else "DB copy"
                found.setdefault(owner, (0, kind))
    leaks = []
    for path, (_, kind) in found.items():
        try:
            if now - newest_mtime(path) < min_age_s:
                continue
        except OSError:
            continue
        leaks.append((path, tree_size(path), kind))
    return sorted(leaks, key=lambda x: -x[1])


def cmd_audit(args) -> int:
    vr = video_paths.video_root()
    print(f"video tree  {vr}")
    raw_total = 0
    if vr.is_dir():
        for part in ("videos", "frames_raw", "frames_curated"):
            p = vr / part
            if p.exists():
                size = tree_size(p)
                raw_total += size if part == "frames_raw" else 0
                print(f"  {part:<15} {human(size):>10}")
        raw = vr / "frames_raw"
        if raw.is_dir():
            for slug_dir in sorted(raw.iterdir()):
                meta = slug_dir / "video_meta.json"
                if (
                    meta.exists()
                    and not json.loads(meta.read_text()).get("raw_pruned")
                    and (vr / "frames_curated" / slug_dir.name).is_dir()
                ):
                    print(
                        f"  prunable raw   {slug_dir.name} ({human(tree_size(slug_dir))})"
                    )
    leaks = find_leaks(args.min_age * 60)
    opened = open_paths()
    print(f"temp roots  {', '.join(map(str, temp_roots()))}")
    stale = [(p, n, k) for p, n, k in leaks if not in_use(p, opened)]
    for p, n, k in leaks:
        flag = "in use" if (p, n, k) not in stale else "LEAK"
        print(f"  {flag:<7} {human(n):>10}  {k:<28} {p}")
    total = sum(n for _, n, _ in stale)
    free = free_bytes(Path.cwd())
    print(f"leaked      {len(stale)} item(s), {human(total)}")
    print(f"disk free   {human(free)}")
    if shutil.which("docker"):
        out = subprocess.run(
            ["docker", "system", "df", "--format", "{{.Type}}\t{{.Reclaimable}}"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        for line in out.stdout.splitlines():
            if line.startswith("Build Cache") and not line.split("\t")[-1].startswith(
                "0B"
            ):
                print(f"docker      build cache reclaimable: {line.split(chr(9))[1]}")
    if stale:
        print("run: python3 $V/video_storage.py clean")
    return 1 if stale else 0


def cmd_clean(args) -> int:
    leaks = find_leaks(args.min_age * 60)
    opened = open_paths()
    freed = 0
    for path, size, kind in leaks:
        if in_use(path, opened):
            print(f"  keep    {path} (open by a running process)")
            continue
        freed += size
        if args.dry_run:
            print(f"  would   {human(size):>10}  {kind:<28} {path}")
            continue
        if path.is_dir():
            shutil.rmtree(path, ignore_errors=True)
        else:
            for p in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
                p.unlink(missing_ok=True)
        print(f"  removed {human(size):>10}  {kind:<28} {path}")
    print(f"{'would free' if args.dry_run else 'freed'} {human(freed)}")
    return 0


# ------------------------------------------------------------------ raw frames


def sha16(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(8 * MB), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def video_for(slug: str) -> tuple[Path, dict]:
    vr = video_paths.video_root()
    meta_path = vr / "frames_raw" / slug / "video_meta.json"
    if not meta_path.exists():
        sys.exit(f"{meta_path} missing: extract {slug} first")
    meta = json.loads(meta_path.read_text())
    return vr / "videos" / meta["source_file"], meta


def cmd_prune_raw(args) -> int:
    vr = video_paths.video_root()
    raw_root = vr / "frames_raw"
    manifest = (
        json.loads((vr / "manifest.json").read_text())
        if (vr / "manifest.json").exists()
        else {}
    )
    curated_by_slug: dict[str, int] = {}
    for e in manifest.get("frames", []):
        curated_by_slug[e["video"]] = curated_by_slug.get(e["video"], 0) + 1
    slugs = args.videos or sorted(
        d.name for d in raw_root.iterdir() if (d / "video_meta.json").exists()
    )
    freed = 0
    for slug in slugs:
        raw = raw_root / slug
        video, meta = video_for(slug)
        if not curated_by_slug.get(slug):
            print(
                f"  skip  {slug}: not deduped yet (raw frames are still the dedupe input)"
            )
            continue
        if not video.exists():
            print(
                f"  skip  {slug}: {video.name} is not in videos/, so raw frames are the only copy"
            )
            continue
        if (
            not meta.get("raw_pruned")
            and meta.get("sha256_16")
            and sha16(video) != meta["sha256_16"]
        ):
            print(
                f"  skip  {slug}: {video.name} changed since extraction; re-extract instead"
            )
            continue
        size = 0
        for f in raw.iterdir():
            if f.suffix == ".png" and f.name.startswith(RAW_PREFIXES):
                size += tree_size(f)
                if not args.dry_run:
                    f.unlink()
        if not args.dry_run:
            meta.update(raw_pruned=True, raw_pruned_bytes=size)
            (raw / "video_meta.json").write_text(json.dumps(meta, indent=2) + "\n")
        freed += size
        print(f"  {'would prune' if args.dry_run else 'pruned'} {slug}: {human(size)}")
    print(
        f"{'would free' if args.dry_run else 'freed'} {human(freed)}; frames.csv, events.json, "
        "transcripts and ocr.tsv kept; `restore` brings any window back"
    )
    return 0


def parse_ts(text: str) -> float:
    parts = [float(p) for p in text.split(":")]
    secs = 0.0
    for p in parts:
        secs = secs * 60 + p
    return secs


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args],
        check=True,
    )


def restore_raw(slug: str, lo: float, hi: float, include_scene: bool = True) -> int:
    """Re-extract the raw frames frames.csv lists in [lo, hi] that are not on disk, with the
    filter that made them, so a restored frame is the extracted frame pixel for pixel:
      sample  f_N  the same fps filter, keeping outputs N-1 (select counts fps outputs)
      scene   s_N  the same scene select, keeping outputs N-1
      settle, transient, pre (e_N)  a decoded frame at its pts: input seek plus decode
                   is frame-accurate
    Samples and scenes are numbered from the start, so those passes decode from 0 to hi."""
    vr = video_paths.video_root()
    raw = vr / "frames_raw" / slug
    video, meta = video_for(slug)
    if not video.exists():
        sys.exit(f"{video} missing: the raw window cannot be rebuilt without the video")
    want: dict[str, list[tuple[int, str, float]]] = {}
    with (raw / "frames.csv").open() as fh:
        for row in csv.DictReader(fh):
            t = float(row["t"])
            if not lo <= t <= hi or (raw / row["file"]).exists():
                continue
            if row["source"] == "scene" and not include_scene:
                continue
            idx = int(re.sub(r"\D", "", row["file"]) or 0)
            want.setdefault(row["source"], []).append((idx, row["file"], t))
    made = 0
    stop = f"{hi + 2:.3f}"
    for source, vf in (
        ("sample", f"fps={meta.get('fps') or 2}"),
        ("scene", f"select='gt(scene,{meta.get('scene_min') or 0.02})'"),
    ):
        items = want.get(source) or []
        if not items:
            continue
        a, b = min(i for i, _, _ in items) - 1, max(i for i, _, _ in items) - 1
        with tempfile.TemporaryDirectory(dir=raw) as tmp:
            _ffmpeg(
                "-t",
                stop,
                "-i",
                str(video),
                "-vf",
                f"{vf},select='between(n\\,{a}\\,{b})'",
                "-fps_mode",
                "passthrough",
                "-start_number",
                str(a + 1),
                f"{tmp}/%06d.png",
            )
            for idx, name, _t in items:
                got = Path(tmp) / f"{idx:06d}.png"
                if got.exists():
                    got.rename(raw / name)
                    made += 1
    decoded = [
        x
        for src, items in want.items()
        if src not in ("sample", "scene")
        for x in items
    ]
    for (
        _idx,
        name,
        t,
    ) in decoded:  # settle, transient and pre frames: decoded at their pts
        _ffmpeg(
            "-ss",
            f"{max(t - 0.0006, 0):.4f}",
            "-i",
            str(video),
            "-frames:v",
            "1",
            str(raw / name),
        )
        made += 1
    return made


def cmd_restore(args) -> int:
    n = restore_raw(args.video, parse_ts(args.from_), parse_ts(args.to))
    print(f"restored {n} raw frames of {args.video} [{args.from_} .. {args.to}]")
    return 0


def cmd_preflight(args) -> int:
    video = Path(args.video)
    need = video.stat().st_size * RAW_PER_VIDEO_BYTE + FREE_FLOOR
    free = free_bytes(video_paths.video_root())
    if free < need:
        print(
            f"refuse {video.name}: extraction needs ~{human(need)} free, disk has {human(free)}. "
            "Run `video_storage.py clean` and `prune-raw` on finished videos, then retry."
        )
        return 1
    return 0


# ------------------------------------------------------------------ test code


LEAK_RULES = (
    (
        re.compile(r"\bmkdtemp\("),
        re.compile(r"atexit\.register\(|rmtree|addClassCleanup|addCleanup"),
        "mkdtemp without a cleanup registered in the same file",
    ),
    (
        re.compile(r"shutil\.copy(?:2|file)?\([^)]*\.db"),
        None,
        "full copy of a database file; clone it copy-on-write (video_storage.clone_db)",
    ),
    (
        re.compile(
            r"shutil\.copy(?:2|file)?\([^)]*(DB|_db|db_path|SOURCE|SEEDED)",
            re.IGNORECASE,
        ),
        None,
        "full copy of a database file; clone it copy-on-write (video_storage.clone_db)",
    ),
)


def cmd_check_tests(args) -> int:
    root = Path(args.dir or video_paths.project())
    hits = []
    for f in root.rglob("*.py"):
        parts = set(f.parts)
        if parts & {".venv", "node_modules", ".git", "site-packages"}:
            continue
        if "test" not in f.name and "tests" not in parts and "conftest" not in f.name:
            continue
        try:
            text = f.read_text()
        except (OSError, UnicodeDecodeError):
            continue
        for pat, cure, why in LEAK_RULES:
            m = pat.search(text)
            if m and not (cure and cure.search(text)):
                line = text.count("\n", 0, m.start()) + 1
                hits.append(f"{f.relative_to(root)}:{line}: {why}")
    hits = list({h.split(": ", 1)[0]: h for h in reversed(hits)}.values())[::-1]
    for h in hits:
        print(h)
    print(
        f"{len(hits)} storage leak(s) in test code"
        if hits
        else "test code: no storage leaks"
    )
    return 1 if hits else 0


# ------------------------------------------------------------------ selftest


def cmd_selftest(_args) -> int:
    """Prune then restore a synthetic video's raw frames and prove the restored frames are
    the extracted ones, pixel for pixel; prove a DB clone is byte-equal; prove the leak
    scanner flags a mkdtemp with no cleanup."""
    tmp = Path(tempfile.mkdtemp(prefix="seemly-storage-selftest-"))
    try:
        vr = tmp / "07_video"
        raw = vr / "frames_raw" / "clip"
        (vr / "videos").mkdir(parents=True)
        raw.mkdir(parents=True)
        video = vr / "videos" / "clip.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x180:rate=30:duration=4",
                "-pix_fmt",
                "yuv420p",
                str(video),
            ],
            check=True,
        )
        log = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "info",
                "-i",
                str(video),
                "-vf",
                "fps=2,showinfo",
                str(raw / "f_%06d.png"),
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stderr
        rows = sorted(raw.glob("f_*.png"))
        ts = [
            float(m)
            for m in re.findall(
                r"Parsed_showinfo.* n: *\d+ .*?pts_time:([-0-9.]+)", log
            )
        ]
        assert len(ts) == len(rows), "showinfo and frame count disagree"
        rows = list(rows)
        _ffmpeg(
            "-i",
            str(video),
            "-vf",
            "select='eq(n\\,37)'",
            "-frames:v",
            "1",
            str(raw / "e_000001.png"),
        )  # an event frame: decoded frame 37, t = 37/30
        rows.append(raw / "e_000001.png")
        lines = [f"{r.name},{t:.3f},sample,\n" for r, t in zip(rows, ts)]
        lines.append(f"e_000001.png,{37 / 30:.3f},settle,\n")
        (raw / "frames.csv").write_text("file,t,source,scene_score\n" + "".join(lines))
        (raw / "video_meta.json").write_text(
            json.dumps(
                {"slug": "clip", "source_file": video.name, "sha256_16": sha16(video)}
            )
        )
        (vr / "manifest.json").write_text(
            json.dumps({"frames": [{"video": "clip"}], "videos": {}})
        )
        keep = tmp / "orig"
        keep.mkdir()
        for r in rows:
            shutil.copy2(r, keep / r.name)
        before = {r.name: keep / r.name for r in rows}
        os.environ["SEEMLY_VIDEO_ROOT"] = str(vr)
        ns = argparse.Namespace(videos=["clip"], dry_run=False)
        cmd_prune_raw(ns)
        assert not list(raw.glob("f_*.png")), "prune left raw frames"
        assert json.loads((raw / "video_meta.json").read_text())["raw_pruned"]
        restore_raw("clip", 0, 1.6)  # a window: frames after it must stay pruned
        restored = {r.name for r in raw.glob("*_*.png")}
        expect = {r.name for r, t in zip(rows, ts + [37 / 30]) if t <= 1.6}
        assert restored == expect, (
            f"restored {sorted(restored)}, expected {sorted(expect)}"
        )
        restore_raw("clip", 0, 99)
        same = 0  # compare decoded pixels, not PNG bytes
        for name, orig in before.items():
            a = subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-i",
                    str(orig),
                    "-f",
                    "rawvideo",
                    "-",
                ],
                capture_output=True,
                check=True,
            ).stdout
            b = subprocess.run(
                [
                    "ffmpeg",
                    "-loglevel",
                    "error",
                    "-i",
                    str(raw / name),
                    "-f",
                    "rawvideo",
                    "-",
                ],
                capture_output=True,
                check=True,
            ).stdout
            same += a == b
        assert same == len(before), f"restore matched {same}/{len(before)} frames"
        db = tmp / "a.db"
        db.write_bytes(os.urandom(MB))
        clone_db(db, tmp / "b.db")
        assert (tmp / "b.db").read_bytes() == db.read_bytes()
        t = tmp / "tests"
        t.mkdir()
        (t / "base.py").write_text("import tempfile\nd = tempfile.mkdtemp()\n")
        assert cmd_check_tests(argparse.Namespace(dir=str(tmp))) == 1
        print(
            f"storage selftest OK: prune + restore {same}/{len(before)} frames pixel-equal, "
            "clone byte-equal, leak scanner fires"
        )
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ main


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("audit", "clean"):
        p = sub.add_parser(name)
        p.add_argument(
            "--min-age",
            type=float,
            default=60,
            help="minutes untouched before a copy counts as leaked",
        )
        if name == "clean":
            p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("prune-raw")
    p.add_argument("videos", nargs="*")
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("restore")
    p.add_argument("video")
    p.add_argument("--from", dest="from_", required=True)
    p.add_argument("--to", required=True)
    p = sub.add_parser("clone")
    p.add_argument("src")
    p.add_argument("dst")
    p = sub.add_parser("check-tests")
    p.add_argument("dir", nargs="?")
    p = sub.add_parser("preflight")
    p.add_argument("video")
    sub.add_parser("selftest")
    args = ap.parse_args()
    if args.cmd == "clone":
        src = Path(args.src)
        how = (
            clone_db(src, Path(args.dst))
            if src.suffix in DB_SUFFIXES
            else clone_file(src, Path(args.dst))
        )
        print(how)
        return 0
    return {
        "audit": cmd_audit,
        "clean": cmd_clean,
        "prune-raw": cmd_prune_raw,
        "restore": cmd_restore,
        "check-tests": cmd_check_tests,
        "preflight": cmd_preflight,
        "selftest": cmd_selftest,
    }[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
