"""Speech for dedupe_frames.py `transcribe` (VIDEO_SKILL_REQUIREMENTS V1).

Speech-to-text is the default: HR-side recordings usually carry no subtitles. Order:
  1. an embedded subtitle track (extract_frames.sh saved it as subs.srt), if present;
  2. otherwise a local faster-whisper model on audio.wav, with segment timestamps;
  3. no audio, or silence: an empty transcript with a note. Frame work never waits on it.
Captions are never read by seeking a player.

Everything stays local (frames_raw/<slug>/ is gitignored): speech can carry names. Only
labels derived from it are ever committed. Repeated consecutive lines are merged.

faster-whisper is not in dedupe_frames.py's inline dependencies (it is large); run
    uv run --with faster-whisper scripts/dedupe_frames.py transcribe <slug>
extract_frames.sh does that for you.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


def _srt_time(text: str) -> float:
    h, m, rest = text.replace(",", ".").split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def parse_srt(path: Path) -> list[dict]:
    segs = []
    for block in re.split(r"\n\s*\n", path.read_text(errors="replace").strip()):
        lines = [x.strip() for x in block.splitlines() if x.strip()]
        timing = next((x for x in lines if "-->" in x), None)
        if not timing:
            continue
        a, b = (s.strip().split()[0] for s in timing.split("-->"))
        text = " ".join(x for x in lines[lines.index(timing) + 1 :])
        text = re.sub(r"<[^>]+>", "", text).strip()
        if text:
            segs.append({"t0": round(_srt_time(a), 3), "t1": round(_srt_time(b), 3), "text": text})
    return segs


def merge_repeats(segs: list[dict]) -> tuple[list[dict], int]:
    """Collapse consecutive identical (or contained, rolling-caption) lines into one."""
    out: list[dict] = []
    merged = 0
    for s in segs:
        if out:
            last = out[-1]
            a, b = last["text"].lower(), s["text"].lower()
            if a == b or b in a:
                last["t1"] = max(last["t1"], s["t1"])
                merged += 1
                continue
            if a in b:  # rolling caption grew
                last["text"], last["t1"] = s["text"], s["t1"]
                merged += 1
                continue
        out.append(dict(s))
    return out, merged


def whisper(audio: Path, model: str, language: str | None) -> tuple[list[dict], str]:
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError:
        return [], (
            "faster-whisper not installed: run "
            "`uv run --with faster-whisper scripts/dedupe_frames.py transcribe <slug>`"
        )
    import wave

    import numpy as np

    # extract_frames.sh wrote 16 kHz mono PCM; passing samples avoids PyAV file decoding,
    # whose API faster-whisper does not always track.
    with wave.open(str(audio)) as w:
        pcm = (
            np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        )
    m = WhisperModel(model, device="cpu", compute_type="int8")
    segments, info = m.transcribe(pcm, language=language, vad_filter=True, word_timestamps=False)
    segs = [
        {"t0": round(s.start, 3), "t1": round(s.end, 3), "text": s.text.strip()}
        for s in segments
        if s.text.strip()
    ]
    return (
        segs,
        f"faster-whisper {model}, language {info.language} ({info.language_probability:.2f})",
    )


def run(
    slug_dir: Path, model: str = "base", language: str | None = None, force: bool = False
) -> dict:
    out_json = slug_dir / "transcript.json"
    srt, wav = slug_dir / "subs.srt", slug_dir / "audio.wav"
    if out_json.exists() and not force:
        newest = max((p.stat().st_mtime for p in (srt, wav) if p.exists()), default=0)
        if out_json.stat().st_mtime >= newest:
            return json.loads(out_json.read_text())

    if srt.exists() and srt.stat().st_size > 0:
        segs, source = parse_srt(srt), "subtitle track"
    elif wav.exists() and wav.stat().st_size > 1024:
        segs, source = whisper(wav, model, language)
    else:
        segs, source = [], "no audio track"
    segs, merged = merge_repeats(segs)
    note = "" if segs else f"empty transcript: {source}"
    data = {"source": source, "segments": segs, "merged_repeats": merged, "note": note}
    out_json.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    (slug_dir / "transcript.txt").write_text(
        "".join(f"[{_fmt(s['t0'])}-{_fmt(s['t1'])}] {s['text']}\n" for s in segs) or f"({note})\n"
    )
    return data


def _fmt(t: float) -> str:
    m, s = divmod(int(t), 60)
    return f"{m:02d}:{s:02d}"


def frame_speech(
    slug_dir: Path, frames: list[dict], before: float = 6.0, after: float = 2.0
) -> int:
    """Write frame_speech.tsv: the speech around each curated frame (local file, by id)."""
    tj = slug_dir / "transcript.json"
    if not tj.exists():
        return 0
    segs = json.loads(tj.read_text()).get("segments", [])
    rows = []
    for f in frames:
        t = f["t"]
        near = [s["text"] for s in segs if s["t1"] >= t - before and s["t0"] <= t + after]
        if near:
            rows.append(f"{f['id']}\t{f['timestamp']}\t{' '.join(near)}")
    (slug_dir / "frame_speech.tsv").write_text("\n".join(rows) + ("\n" if rows else ""))
    return len(rows)
