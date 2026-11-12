"""`dedupe_frames.py selftest`: prove the video pipeline misses nothing, on a known video.

Renders a 20 s, 30 fps, 1280x720 H.264 recording of a fake app with a pointer that never
stops moving, and planted events whose timing and pixels are known. The two shortest states (a 200 ms
tooltip, a 350 ms spinner) sit between 2 fps sample times on purpose: only the
native-fps event pass can catch them. Each event is also
painted in a unique colour at a known spot, so the check reads the curated frames'
pixels, not their timestamps alone. Runs the real pipeline (extract_frames.sh, the
event pass, dedupe) on a temp tree via SEEMLY_VIDEO_ROOT and passes only if every planted
state has a curated frame showing it, and pointer motion alone did not flood the set.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

W, H, FPS, DUR = 1280, 720, 30, 20.0
SCRIPTS = Path(__file__).resolve().parent

BLUE, GREEN, TEAL = (40, 90, 220), (40, 170, 80), (0, 128, 128)
YELLOW, PURPLE, ORANGE = (250, 220, 40), (130, 40, 160), (245, 140, 20)
RED, CYAN, PINK, BLACK = (220, 40, 40), (40, 210, 230), (240, 100, 180), (0, 0, 0)

# name, probe point, colour, window [t0, t1): a curated frame inside the window must show it
TRUTH = [
    ("page A", (900, 250), BLUE, 0.0, 3.0),
    ("tooltip 200 ms", (800, 220), YELLOW, 3.1, 3.3),
    ("spinner 350 ms", (600, 360), PURPLE, 4.1, 4.45),
    ("page B", (900, 250), GREEN, 4.45, 6.0),
    ("dropdown open", (1000, 200), ORANGE, 6.0, 8.0),
    ("modal open", (640, 435), RED, 8.5, 10.5),
    ("toast", (1100, 655), CYAN, 11.0, 14.0),
    ("tab 2", (900, 250), TEAL, 14.5, 15.5),
    ("typing, final text", (100 + 14 * 22 + 6, 580), BLACK, 17.0, 17.5),
    ("scrolled to footer", (300, 660), PINK, 18.5, 20.0),
]


def render(t: float) -> Image.Image:
    im = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 60], fill=(60, 60, 70))  # app header
    d.rectangle([20, 18, 220, 42], fill=(200, 200, 210))
    shift = 0
    if t >= 17.5:
        shift = int(200 * min(1.0, (t - 17.5) / 1.0))
    content = BLUE if t < 4.45 else (GREEN if t < 14.5 else TEAL)
    if t >= 4.1 and t < 4.45:
        content = None  # page loading
    top = 150 - shift
    if content:
        d.rectangle([100, top, 1100, top + 350], fill=content)
        for i in range(5):  # list rows
            d.rectangle([120, top + 20 + i * 60, 700, top + 50 + i * 60], fill=(255, 255, 255))
    d.rectangle([100, 560 - shift, 600, 600 - shift], outline=(120, 120, 120), width=2)  # field
    if t >= 15.5:
        chars = min(15, int((t - 15.5) / 0.1) + 1)
        for i in range(chars):
            x = 100 + i * 22
            d.rectangle([x + 2, 568 - shift, x + 14, 592 - shift], fill=BLACK)
    d.rectangle([100, 820 - shift, 600, 900 - shift], fill=PINK)  # footer, visible after scroll
    if t >= 14.5:
        d.rectangle([300, 120, 420, 128], fill=(200, 0, 200))  # active tab underline
    if 3.1 <= t < 3.3:
        d.rectangle([700, 200, 900, 240], fill=YELLOW)
    if 4.1 <= t < 4.45:
        a = (t - 4.1) * 720
        d.arc([560, 320, 720, 400], start=a, end=a + 300, fill=PURPLE, width=14)
        d.ellipse([594, 354, 606, 366], fill=PURPLE)
    if 6.0 <= t < 8.0:
        d.rectangle([900, 80, 1150, 300], fill=ORANGE)
    if 8.5 <= t < 10.5:
        d.rectangle([0, 0, W, H], fill=(90, 90, 90))
        d.rectangle([440, 250, 840, 470], fill=(255, 255, 255))
        d.rectangle([600, 420, 680, 450], fill=RED)
    if 11.0 <= t < 14.0:
        d.rectangle([900, 620, 1250, 690], fill=CYAN)
    # the pointer never stops moving
    cx = 640 + 500 * math.sin(t * 0.9)
    cy = 360 + 250 * math.sin(t * 1.3)
    d.polygon(
        [(cx, cy), (cx, cy + 18), (cx + 5, cy + 14), (cx + 12, cy + 14)],
        fill=BLACK,
        outline=(255, 255, 255),
    )
    return im


def make_video(path: Path) -> None:
    proc = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-r",
            str(FPS),
            "-i",
            "pipe:0",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "23",
            str(path),
        ],
        stdin=subprocess.PIPE,
    )
    assert proc.stdin is not None
    for i in range(int(DUR * FPS)):
        proc.stdin.write(render(i / FPS).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed to render the test video")


def add_speech(video: Path) -> Path:
    aiff = video.with_suffix(".aiff")
    subprocess.run(
        ["say", "-o", str(aiff), "Open the timecard and approve the exception"], check=True
    )
    out = video.with_name("selftest-speech.mp4")
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(video),
            "-itsoffset",
            "2",
            "-i",
            str(aiff),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            str(out),
        ],
        check=True,
    )
    video.unlink()
    aiff.unlink()
    return out


def close(c1, c2, tol: int = 60) -> bool:
    return all(abs(a - b) <= tol for a, b in zip(c1, c2, strict=False))


def unit_checks(tmp: Path) -> bool:
    """State layer (V4 c-d, V10), masking and pii-check (V6) on known inputs."""
    import video_privacy
    import video_states

    ok = True
    frames = [
        {
            "id": "a@1",
            "video": "a",
            "t": 1.0,
            "screen": "Timecard",
            "screen_slug": "timecard",
            "state": "rest",
            "frame_kind": "web-ui",
            "keep_reasons": ["settle"],
            "fields_visible": ["Date", "In"],
            "covers": ["S02/x"],
        },
        {
            "id": "a@9",
            "video": "a",
            "t": 9.0,
            "screen": "Timecard",
            "screen_slug": "timecard",
            "state": "rest",
            "frame_kind": "web-ui",
            "keep_reasons": ["sample"],
            "fields_visible": ["Date"],
            "covers": ["S02/x"],
        },
        {
            "id": "b@4",
            "video": "b",
            "t": 4.0,
            "screen": "Timecard",
            "screen_slug": "timecard",
            "state": "rest",
            "frame_kind": "web-ui",
            "keep_reasons": ["sample"],
            "fields_visible": ["Date"],
            "covers": ["S02/y"],
        },
        {
            "id": "b@7",
            "video": "b",
            "t": 7.0,
            "screen": "Timecard",
            "screen_slug": "timecard",
            "state": "open",
            "frame_kind": "web-ui",
            "keep_reasons": ["sample"],
        },
    ]
    _states, rep = video_states.states_pass(frames, {"a": "real-tenant", "b": "trainer"})
    want = {"states": 2, "merged_as_alias": 1, "pinned_sole_evidence": 1, "cross_video_states": 1}
    got = {k: rep[k] for k in want}
    good = got == want and frames[1].get("alias_of") == "a@1" and "alias_of" not in frames[2]
    print(f"state layer      {'OK' if good else 'FAIL'}  {got} (b@4 kept: sole evidence for S02/y)")
    ok &= good

    img = tmp / "mask.png"
    im = Image.new("RGB", (900, 200), (255, 255, 255))
    from PIL import ImageFont

    ImageDraw.Draw(im).text(
        (40, 70), "Manager  Alex Doe", fill=BLACK, font=ImageFont.load_default(size=48)
    )
    im.save(img)
    n = video_privacy.mask_frame(img, 0.0, ["Alex Doe"])
    with Image.open(img) as m2:
        dark = sum(1 for px in m2.convert("RGB").getdata() if px == (40, 40, 40))
    good = n >= 2 and dark > 2000  # both words of the name are solid boxes
    print(f"pii mask         {'OK' if good else 'FAIL'}  {n} word boxes filled")
    ok &= good

    # By pattern, with an empty list: people nobody listed (a Reports To value, a "Last, First"
    # row, a badge in a grid under a centred header) are masked; the labels stay readable.
    form = tmp / "form.png"
    im = Image.new("RGB", (1600, 520), (255, 255, 255))
    d = ImageDraw.Draw(im)
    font = ImageFont.load_default(size=30)
    d.text((40, 40), "Reports To", fill=BLACK, font=font)
    d.text((330, 40), "Sam Rivera", fill=BLACK, font=font)
    d.text((40, 120), "Rivera, Sam", fill=BLACK, font=font)
    d.text((40, 170), "12346", fill=BLACK, font=font)
    for x, head in ((300, "Badge Number"), (700, "Start Date"), (1050, "End Date")):
        d.text((x, 300), head, fill=BLACK, font=font)
    d.text((260, 380), "10338925", fill=BLACK, font=font)
    d.text((700, 380), "9/01/2013", fill=BLACK, font=font)
    im.save(form)
    video_privacy.mask_frame(form, 0.0, [])
    seen = " ".join(w for w, _b, _k in video_privacy.ocr_words(form))
    leaked = [v for v in ("Rivera", "10338925", "12346") if v in seen]
    kept = [v for v in ("Reports", "Start", "Date") if v in seen]
    good = not leaked and len(kept) == 3
    print(f"pattern mask     {'OK' if good else 'FAIL'}  leaked {leaked or 'none'}; labels kept {kept}")
    ok &= good

    pii = tmp / "pii.json"
    pii.write_text(json.dumps({"names": ["seemly"]}))  # a word the skill's tracked files contain
    hit = bool(video_privacy.check(SCRIPTS.parent, pii))
    pii.write_text(
        json.dumps({"names": ["Zq" + "x Canary" + " Nobody"]})
    )  # joined at runtime: in no file
    clean = not video_privacy.check(SCRIPTS.parent, pii)
    print(
        f"pii-check        {'OK' if hit and clean else 'FAIL'}  blocks a known term: {hit}; clean when absent: {clean}"
    )
    return ok and hit and clean


def main(keep: bool = False, speech: bool = False) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="seemly-video-selftest-"))
    vroot = tmp / "07_video"
    for d in ("videos", "frames_raw", "frames_curated"):
        (vroot / d).mkdir(parents=True)
    video = vroot / "videos" / "selftest.mp4"
    print(f"rendering {DUR:.0f} s test video ({len(TRUTH)} planted states, pointer always moving)")
    make_video(video)
    if speech:
        video = add_speech(video)
    # A variable-frame-rate copy (frame durations change mid-clip, as in a Teams or screen-share
    # recording): every scene frame file must match its line in scene_scores.txt.
    vfr = vroot / "videos" / "selftest-vfr.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf",
            "setpts='if(lt(N,150),N/30,5+(N-150)/7)/TB'", "-fps_mode", "vfr", "-an", str(vfr),
        ],
        check=True,
    )
    env = {**os.environ, "SEEMLY_VIDEO_ROOT": str(vroot), "SPEECH": "1" if speech else "0"}
    subprocess.run([str(SCRIPTS / "extract_frames.sh")], env=env, check=True)
    subprocess.run(
        ["uv", "run", "--quiet", str(SCRIPTS / "dedupe_frames.py"), "dedupe"], env=env, check=True
    )

    vraw = vroot / "frames_raw" / vfr.stem
    files = len(list(vraw.glob("s_*.png")))
    scores = sum(1 for ln in (vraw / "scene_scores.txt").read_text().splitlines() if ln.startswith("frame:"))
    vfr_ok = files == scores and files >= 5
    print(f"vfr scene pass   {'OK' if vfr_ok else 'FAIL'}  {files} scene frames for {scores} scene scores")

    manifest = json.loads((vroot / "manifest.json").read_text())
    slug = video.stem
    frames = [f for f in manifest["frames"] if f["video"] == slug]
    cur = vroot / "frames_curated" / slug
    ok = True
    print(f"\n{'planted state':24} {'window':>12}  result")
    for name, (x, y), colour, t0, t1 in TRUTH:
        hits = []
        for f in frames:
            if not (t0 - 0.05 <= f["t"] < t1 + 0.05):
                continue
            with Image.open(cur / f["file"]) as im:
                if close(im.convert("RGB").getpixel((x, y)), colour):
                    hits.append(f"{f['t']:.2f}s {f.get('source')}")
        ok &= bool(hits)
        print(
            f"{name:24} {t0:5.1f}-{t1:<5.1f}  {'CAUGHT ' + ', '.join(hits[:3]) if hits else 'MISSED'}"
        )

    raw = manifest["videos"][slug]["raw_frames"]
    print(
        f"\ncurated {len(frames)} of {raw} pool frames; layers {manifest['videos'][slug]['layers']}"
    )
    if len(frames) > 4 * len(TRUTH):
        print(
            f"FLOOD: {len(frames)} curated frames for {len(TRUTH)} states (pointer motion leaking)"
        )
        ok = False
    if speech:
        tj = vroot / "frames_raw" / slug / "transcript.json"
        tr = (
            json.loads(tj.read_text())
            if tj.exists()
            else {"source": "transcribe failed", "segments": []}
        )
        text = " ".join(s["text"] for s in tr["segments"]).lower()
        squashed = text.replace(" ", "")
        heard = "timecard" in squashed and "approve" in squashed
        attached = vroot / "frames_raw" / slug / "frame_speech.tsv"
        n_att = len(attached.read_text().splitlines()) if attached.exists() else 0
        print(
            f"speech: {tr['source']}: {text!r} -> {'OK' if heard else 'MISSED'}; "
            f"attached to {n_att} curated frames"
        )
        heard = heard and n_att > 0
        ok &= heard
    print()
    ok &= unit_checks(tmp) and vfr_ok
    print("\nSELFTEST " + ("PASS" if ok else "FAIL") + (f"  (tree kept: {tmp})" if keep else ""))
    if not keep:
        shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(keep="--keep" in sys.argv, speech="--speech" in sys.argv))
