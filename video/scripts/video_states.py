"""State-level and cross-video dedupe for dedupe_frames.py (VIDEO_SKILL_REQUIREMENTS V4 c-d, V10).

Layers after frame-level dedupe and settle:
  seen         a curated frame IDENTICAL to one already labelled (any video: pHash within
               1 bit, 16x16 dHash within 4, at most 3 changed pixels on a 128x72 thumbnail)
               inherits its labels (`labels_from`) and is flagged `seen`, so it is never
               sent to vision again. Cache: frames_raw/seen.json (local).
  state        labelled frames with the same screen_slug + state collapse into one
               canonical state; one best frame, the others are aliases (`alias_of`).
  cross-video  the key has no video in it, so a state seen in several videos is one
               state with several sources.
  pin (V10)    a frame is never made an alias while it is the only evidence for a
               coverage-contract item (an id in its `covers` the canonical frame lacks):
               it stays canonical and is counted as pinned.
Nothing is deleted: aliases keep their files; the build reads canonical frames.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import imagehash
import numpy as np
from PIL import Image

SOURCE_RANK = {"real-tenant": 0, "vendor-official": 1, "trainer": 2, "farm": 3}
SOURCE_PREF = {"settle": 0, "sample": 1, "scene": 2, "transient": 3, "pre": 4, "rescued": 5}
COPY_FIELDS = (
    "module",
    "screen",
    "screen_slug",
    "flow",
    "state",
    "nav_path",
    "frame_kind",
    "look",
    "entities_visible",
    "fields_visible",
)


def _sig(path: Path) -> dict:
    with Image.open(path) as im:
        im.load()
        thumb = np.asarray(im.convert("L").resize((128, 72), Image.BILINEAR), dtype=np.uint8)
        return {
            "dhash": str(imagehash.dhash(im, hash_size=16)),
            "thumb": base64.b64encode(thumb.tobytes()).decode(),
        }


def same_frame(a: dict, b: dict, max_changed_px: int = 3) -> bool:
    """Strict identity, not similarity: pHash alone gave distance 0 across a full page
    change in the first synthetic test, so it can never decide this by itself."""
    if imagehash.hex_to_hash(a["phash"]) - imagehash.hex_to_hash(b["phash"]) > 1:
        return False
    if imagehash.hex_to_hash(a["dhash"]) - imagehash.hex_to_hash(b["dhash"]) > 4:
        return False
    ta = np.frombuffer(base64.b64decode(a["thumb"]), dtype=np.uint8).astype(np.int16)
    tb = np.frombuffer(base64.b64decode(b["thumb"]), dtype=np.uint8).astype(np.int16)
    return int((np.abs(ta - tb) > 24).sum()) <= max_changed_px


def seen_pass(frames: list[dict], cache_path: Path, curated_dir: Path | None = None) -> int:
    """Labelled frames go into the cache; an unlabelled frame identical to a cached one
    inherits its labels. Needs the curated files (curated_dir/<video>/<file>)."""
    if curated_dir is None:
        return 0
    cache = json.loads(cache_path.read_text()) if cache_path.exists() else {}
    cache = {k: v for k, v in cache.items() if "thumb" in v}  # drop entries from a looser format

    def sig_for(f: dict) -> dict | None:
        path = curated_dir / f["video"] / f["file"]
        return {"phash": f["phash"], **_sig(path)} if f.get("phash") and path.exists() else None

    for f in frames:
        if f.get("screen") and not f.get("labels_from") and f["id"] not in cache:
            sg = sig_for(f)
            if sg:
                cache[f["id"]] = {**sg, **{k: f.get(k) for k in COPY_FIELDS}}
    # same_frame() rejects anything over 1 pHash bit first, so filter the whole cache on that
    # with one array op, and decode a frame only when some cached frame is that close: a
    # 2,239-frame video against a 20 MB cache was a single-core quarter of an hour otherwise.
    ids = list(cache)
    bits = (
        np.array([imagehash.hex_to_hash(cache[i]["phash"]).hash.flatten() for i in ids], dtype=bool)
        if ids
        else np.zeros((0, 64), dtype=bool)
    )
    reused = 0
    for f in frames:
        if f.get("screen") or not f.get("phash"):
            continue
        own = imagehash.hex_to_hash(f["phash"]).hash.flatten()
        near = (
            np.nonzero((bits != own).sum(axis=1) <= 1)[0]
            if bits.shape[1] == own.size
            else range(len(ids))
        )
        if len(near) == 0:
            continue
        sg = sig_for(f)
        if not sg:
            continue
        for cid in (ids[i] for i in near):
            c = cache[cid]
            if cid != f["id"] and same_frame(sg, c):
                for k in COPY_FIELDS:
                    f[k] = c.get(k)
                f["labels_from"] = cid
                if "seen" not in f.setdefault("keep_reasons", []):
                    f["keep_reasons"].append("seen")
                reused += 1
                break
    cache_path.write_text(json.dumps(cache) + "\n")
    return reused


def _quality(f: dict, rank: dict[str, str]) -> tuple:
    src = f.get("keep_reasons") or ["sample"]
    pref = min((SOURCE_PREF.get(r, 9) for r in src + [f.get("source") or ""]), default=9)
    return (
        SOURCE_RANK.get(rank.get(f["video"], ""), 4),
        0 if f.get("frame_kind") in (None, "web-ui") else 1,
        pref,
        -len(f.get("fields_visible") or []),
        f["video"],
        f["t"],
    )


def states_pass(frames: list[dict], video_rank: dict[str, str]) -> tuple[dict, dict]:
    groups: dict[str, list[dict]] = {}
    for f in frames:
        f.pop("alias_of", None)
        f.pop("state_id", None)
        slug = f.get("screen_slug")
        if not slug:
            continue
        key = f"{slug}#{f.get('state') or 'rest'}"
        groups.setdefault(key, []).append(f)

    states: dict[str, dict] = {}
    aliases = pinned = cross = 0
    for key, members in sorted(groups.items()):
        members.sort(key=lambda f: _quality(f, video_rank))
        canon = members[0]
        canon_cover = set(canon.get("covers") or [])
        canonical = [canon]
        alias_ids = []
        for f in members[1:]:
            only_here = (
                set(f.get("covers") or [])
                - canon_cover
                - {c for k in canonical for c in (k.get("covers") or [])}
            )
            f["state_id"] = key
            if only_here:
                canonical.append(f)
                f["pinned_evidence"] = sorted(only_here)
                pinned += 1
            else:
                f["alias_of"] = canon["id"]
                alias_ids.append(f["id"])
                aliases += 1
        canon["state_id"] = key
        videos = sorted({f["video"] for f in members})
        if len(videos) > 1:
            cross += 1
        states[key] = {
            "screen_slug": canon.get("screen_slug"),
            "state": canon.get("state") or "rest",
            "flow": canon.get("flow"),
            "canonical": [c["id"] for c in canonical],
            "aliases": alias_ids,
            "sources": videos,
            "looks": sorted({f.get("look") for f in members if f.get("look")}),
        }
    report = {
        "labelled_frames": sum(len(m) for m in groups.values()),
        "states": len(states),
        "merged_as_alias": aliases,
        "pinned_sole_evidence": pinned,
        "cross_video_states": cross,
    }
    return states, report
