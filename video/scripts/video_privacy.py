"""Privacy for dedupe_frames.py `mask` and `pii-check` (VIDEO_SKILL_REQUIREMENTS V6).

Live-tenant recordings show real people. Before any curated frame is read for labels:
  - the browser chrome band (address bar: tenant host, a signed-in name) is filled solid,
    by a per-video fraction set with `dedupe_frames.py meta <slug> --mask-top 0.09`;
  - every OCR word matching a term in the local pii.json is filled solid;
  - by shape, whether listed or not: emails, money, the value beside or under a person label
    (Name, Reports To, Manager...), the column under such a header, and "Lastname, First".
OCR reads a copy upscaled OCR_SCALE times, since small UI text fails at native size.
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

from PIL import Image, ImageDraw, ImageFilter, ImageOps

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


# OCR reads small or light-on-dark UI text far better upscaled: a frame shown at 1.7x scale
# scored 0 of 13 by OCR at native size. Every OCR call in the skill goes through this factor.
OCR_SCALE = 2


Word = tuple[str, tuple[int, int, int, int], tuple[int, int, int]]  # text, box, (block, par, line)


def ocr_words(img: Path, scale: int = OCR_SCALE) -> list[Word]:
    """Tesseract words (psm 11) with boxes in the image's own pixels, read from a copy
    upscaled `scale` times."""
    src = img
    tmp = None
    if scale > 1:
        with Image.open(img) as im:
            # grey, stretched and sharpened: light-grey labels and text in input boxes read
            big = im.convert("L").resize((im.width * scale, im.height * scale), Image.LANCZOS)
            big = ImageOps.autocontrast(big, cutoff=1).filter(ImageFilter.SHARPEN)
            tmp = img.with_name(f".ocr_{img.stem}.png")
            big.save(tmp)
            src = tmp
    try:
        tsv = subprocess.run(
            ["tesseract", str(src), "-", "--psm", "11", "tsv"],
            check=False,
            capture_output=True,
            text=True,
        ).stdout
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
    out: list[Word] = []
    for line in tsv.splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) == 12 and cols[11].strip():
            x, y, w, h = (int(v) // scale for v in cols[6:10])
            key = (int(cols[2]), int(cols[3]), int(cols[4]))
            out.append((cols[11].strip(), (x, y, x + w, y + h), key))
    return out


def ocr_text(img: Path, scale: int = OCR_SCALE) -> str:
    """Plain OCR text of a frame (the search index), from the upscaled copy."""
    return " ".join(w for w, _, _ in ocr_words(img, scale))


def _word_boxes(img: Path) -> list[tuple[str, tuple[int, int, int, int]]]:
    return [(w, box) for w, box, _ in ocr_words(img)]


# Labels whose value is a person. Real-tenant recordings show people nobody listed ahead of
# time (search results, name lists, Reports To), so the value beside or under one of these
# labels, and a grid column under one as a header, is masked whether or not it is in pii.json.
PERSON_LABELS = (
    "name", "employee", "employee name", "full name", "first name", "last name", "manager",
    "reports to", "supervisor", "assigned to", "approver", "approved by", "requested by",
    "created by", "modified by", "updated by", "owner", "user name", "username",
    "worker", "requester", "submitted by", "employee id", "person number", "badge",
    "badge number", "email", "phone", "sign on email", "signon email", "mobile", "phone 1",
    "phone 2", "phone 3", "address", "home address", "emergency contact",
)
LABEL_HEADS = {label.split(" ")[0] for label in PERSON_LABELS} | {"signon", "city", "state", "zip", "country"}
# A bare run of 6+ digits is an id, badge or phone number (dates, times and amounts carry
# "/", ":" or "."), masked wherever it appears.
ID_SHAPE = re.compile(r"^\+?\d{6,}$")
# "Lastname, Firstname" (a UKG list or grid name) anywhere on screen.
NAME_SHAPE = re.compile(r"^[A-Z][a-zA-Z'\-]{1,}[,]$")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z ]", "", text.lower()).strip()


def pattern_boxes(words: list[Word], height: int, width: int) -> list[tuple[int, int, int, int]]:
    """Boxes to mask by shape: values beside or under a person label, the column under a
    person header, and "Lastname, Firstname" pairs."""
    lines: dict[tuple[int, int, int], list[tuple[str, tuple[int, int, int, int]]]] = {}
    for text, box, key in words:
        lines.setdefault(key, []).append((text, box))
    for ws in lines.values():
        ws.sort(key=lambda w: w[1][0])
    boxes: list[tuple[int, int, int, int]] = []
    flat = [(t, b) for ws in lines.values() for t, b in ws]
    row_h = max(12, int(height * 0.04))
    for ws in lines.values():
        texts = [_norm(t) for t, _ in ws]
        for i in range(len(ws)):
            for span in (3, 2, 1):
                if i + span > len(ws):
                    continue
                phrase = " ".join(texts[i : i + span]).rstrip(":").strip()
                if phrase not in PERSON_LABELS:
                    continue
                # a field label ends its text run ("Manager:" or "Manager" alone); a phrase
                # that runs on ("Manager Role-Scheduler") is a heading, not a label
                if i + span < len(ws) and not ws[i + span - 1][0].endswith(":"):
                    continue
                label_box = (ws[i][1][0], ws[i][1][1], ws[i + span - 1][1][2], ws[i + span - 1][1][3])
                lh = label_box[3] - label_box[1]
                # words below, left-aligned with the label (a grid column under a header)
                aligned = [
                    (t, b) for t, b in flat
                    if b[1] > label_box[3] and abs(b[0] - label_box[0]) <= 12
                    and b[1] <= label_box[3] + height * 0.5
                ]
                labels_below = sum(1 for t, _ in aligned if _norm(t).split(" ")[0] in LABEL_HEADS)
                cy0 = (label_box[1] + label_box[3]) / 2
                beside = [
                    b for _, b in flat
                    if b[0] > label_box[2] and abs((b[1] + b[3]) / 2 - cy0) <= max(lh, 8)
                    and b[0] - label_box[2] <= width * 0.5
                ]
                # under a centred grid header the values overlap its x-range without lining up
                overlap = [
                    (t, b) for t, b in flat
                    if b[1] > label_box[3] and b[1] <= label_box[3] + height * 0.5
                    and b[0] < label_box[2] + 4 and b[2] > label_box[0] - 4
                ]
                def under(box: tuple[int, int, int, int]) -> bool:
                    """A value right under `box`, within a few rows (a grid's next row)."""
                    return any(
                        0 < b[1] - box[3] <= max(lh, 8) * 4 and b[0] < box[2] + 4 and b[2] > box[0] - 4
                        for _, b in flat
                    )

                # a grid header: other headers beside it, with values right under it and them
                if len(beside) >= 2 and overlap and under(label_box) and any(under(b) for b in beside):
                    # a grid header (other headers beside it): the values in its column
                    boxes += [b for t, b in overlap if _norm(t).split(" ")[0] not in LABEL_HEADS]
                elif len(aligned) >= 3 and labels_below * 2 < len(aligned):
                    # a list header with no neighbours: the values under it
                    boxes += [b for t, b in aligned if _norm(t).split(" ")[0] not in LABEL_HEADS]
                else:
                    # a form label: the area to its right on the same visual row. OCR files a
                    # field's value as its own line and can miss it (selected text, an input
                    # box), so the area is masked, not only the words read there.
                    cy = (label_box[1] + label_box[3]) / 2
                    half = max(lh, 8)
                    reach = int(label_box[2] + width * 0.12)
                    boxes.append((label_box[2] + 4, int(cy - half), reach, int(cy + half)))
                    # and the value's words, whole: the first starts inside the reach, and the
                    # run continues while the next word follows within a word gap
                    row = sorted(
                        (b for _, b in flat
                         if b[0] > label_box[2] and abs((b[1] + b[3]) / 2 - cy) <= half),
                        key=lambda b: b[0],
                    )
                    end = reach
                    for b in row:
                        if b[0] > end:
                            break
                        boxes.append(b)
                        end = max(end, b[2] + lh * 2)
                break
        for (t1, b1), (t2, b2) in zip(ws, ws[1:]):
            if NAME_SHAPE.match(t1) and re.match(r"^[A-Z][a-zA-Z'\-]+$", t2):
                boxes += [b1, b2]
                # UKG lists print the person number on the line under the name
                lh = b1[3] - b1[1]
                boxes += [
                    b for _, b in flat
                    if 0 < b[1] - b1[3] <= lh * 2 and abs(b[0] - b1[0]) <= 12
                ]
    boxes += [b for text, b in flat if ID_SHAPE.match(text.strip("()[],;"))]
    return boxes


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
            band = round(im.height * top_frac)
            words = ocr_words(path)
            hits = [box for word, box, _ in words if _matches(word, lower, parts)]
            hits += pattern_boxes([w for w in words if w[1][3] > band], im.height, im.width)
            for x0, y0, x1, y1 in set(hits):
                draw.rectangle([x0 - 2, y0 - 2, x1 + 2, y1 + 2], fill=(40, 40, 40))
                filled += 1
        im.save(path)
    return filled


def mask_video(
    curated_slug_dir: Path, entries: list[dict], top_frac: float, terms: list[str]
) -> dict:
    stamp = f"{top_frac}:{len(terms)}:p2"  # p2: + person labels, name shapes, 2x OCR
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
