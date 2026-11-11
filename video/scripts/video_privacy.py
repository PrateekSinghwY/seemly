"""Privacy for dedupe_frames.py `mask` and `pii-check` (VIDEO_SKILL_REQUIREMENTS V6).

Live-tenant recordings show real people. Before any curated frame is read for labels:
  - the browser chrome band (address bar: tenant host, a signed-in name) is filled solid,
    by a per-video fraction set with `dedupe_frames.py meta <slug> --mask-top 0.09`;
  - every OCR word matching a term in the local pii.json is filled solid.
Fills are solid boxes, so re-running is idempotent (a blur would degrade every pass).

pii.json lives in frames_raw/ (gitignored) and never leaves the machine:
    {"names": ["..."], "emails": ["..."], "ids": ["..."], "hosts": ["..."]}
The labelling session adds what it sees; `pii-check` then fails (exit 1) if any term
appears in a tracked or not-ignored file, printing the file and line, never the term.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

KINDS = ("names", "emails", "ids", "hosts")
# personal values with a shape: emails and wages/amounts ($15.50, 15.50/hr) are blacked out
# even when no one listed them in pii.json
PATTERN = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|\$\s?\d[\d,]*(\.\d{2})?|\d+\.\d{2}/(hr|hour)", re.I)


def load_terms(pii_path: Path) -> list[str]:
    if not pii_path.exists():
        return []
    data = json.loads(pii_path.read_text())
    terms: list[str] = []
    for k in KINDS:
        terms += [str(t).strip() for t in data.get(k, []) if str(t).strip()]
    return sorted(set(terms), key=len, reverse=True)


def _word_boxes(img: Path) -> list[tuple[str, tuple[int, int, int, int]]]:
    tsv = subprocess.run(
        ["tesseract", str(img), "-", "--psm", "11", "tsv"],
        check=False,
        capture_output=True,
        text=True,
    ).stdout
    out = []
    for line in tsv.splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) == 12 and cols[11].strip():
            x, y, w, h = map(int, cols[6:10])
            out.append((cols[11].strip(), (x, y, x + w, y + h)))
    return out


def _matches(word: str, terms_lower: set[str], parts: set[str]) -> bool:
    w = re.sub(r"[^\w@.\-/#]", "", word).lower()
    if not w:
        return False
    if w in terms_lower or w in parts:
        return True
    if PATTERN.search(word):  # any email address or money amount, listed or not
        return True
    # hosts and emails arrive inside a longer OCR "word" (a whole URL): match as a substring
    return any(("." in t or "@" in t) and t in w for t in terms_lower)


def mask_frame(path: Path, top_frac: float, terms: list[str]) -> int:
    """Fill the chrome band and PII words in place. Returns the number of word boxes filled."""
    with Image.open(path) as im:
        im = im.convert("RGB")
        draw = ImageDraw.Draw(im)
        if top_frac > 0:
            draw.rectangle([0, 0, im.width, round(im.height * top_frac)], fill=(40, 40, 40))
        filled = 0
        if shutil.which("tesseract"):
            lower = {t.lower() for t in terms}
            # multi-word terms ("Alex Doe") are matched word by word
            parts = {p.lower() for t in terms for p in t.split() if len(p) > 2}
            for word, box in _word_boxes(path):
                if _matches(word, lower, parts):
                    x0, y0, x1, y1 = box
                    draw.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], fill=(40, 40, 40))
                    filled += 1
        im.save(path)
    return filled


def mask_video(
    curated_slug_dir: Path, entries: list[dict], top_frac: float, terms: list[str]
) -> dict:
    stamp = f"{top_frac}:{len(terms)}:p1"  # p1: email and money patterns
    masked = boxes = 0
    for e in entries:
        f = curated_slug_dir / e["file"]
        if not f.exists() or e.get("masked") == stamp:
            continue
        boxes += mask_frame(f, top_frac, terms)
        e["masked"] = stamp
        masked += 1
    return {"frames_masked": masked, "pii_boxes": boxes}


def check(root: Path, pii_path: Path) -> list[str]:
    """Return 'file:line' hits of any pii.json term in files git would commit."""
    terms = load_terms(pii_path)
    if not terms:
        return []
    files = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    pats = [re.compile(rf"(?<![\w]){re.escape(t)}(?![\w])", re.IGNORECASE) for t in terms]
    hits = []
    for rel in files:
        p = root / rel
        if not p.is_file() or p.stat().st_size > 5_000_000:
            continue
        try:
            text = p.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if any(pt.search(line) for pt in pats):
                hits.append(f"{rel}:{n}")
    return hits
