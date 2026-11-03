#!/usr/bin/env python3
"""Surface-census evidence check (LESSONS #5, promoted to T1).

A surface class recorded as NOT DETECTED is a *negative* result, and a negative result
from one probe on one page is how the feed-pagination reversal happened: the feed was
declared a fixed list after a single scroll test on `home`, which is the one page that
uses a different feed endpoint. Six `oneFeed` requests later proved otherwise.

Rule enforced here: **every NOT DETECTED verdict must cite the probe on every in-scope
page**, either by naming all five page keys in its evidence cell or by saying so
explicitly ("all five pages"), unqualified. A verdict that cites one page, or none, or
says "not all five pages", fails.

Skips cleanly when the discovery folder is absent (it is git-excluded, so CI will not
have it); the check is for the machine doing the recon.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# lib/ sits beside this file once installed (scripts/lib), one level up inside the skill.
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(next((d for d in (_HERE / "lib", _HERE.parent / "lib") if d.is_dir()), _HERE / "lib")))
from check_record import write_check_record  # noqa: E402

NAME = "surface_census_evidence"
def _repo_root() -> Path:
    """The repository the census belongs to, never this skill's own folder.

    RL_REPO wins; else the git top-level of the working directory; else the working
    directory. The script lives under .claude/skills/seemly/scripts/gates/, so a path
    derived from __file__ would look for discovery data inside the skill and always skip.
    """
    import os, subprocess
    env = os.environ.get("RL_REPO")
    if env:
        return Path(env).resolve()
    try:
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, check=True).stdout.strip()
        if top:
            return Path(top)
    except (OSError, subprocess.CalledProcessError):
        pass
    return Path.cwd().resolve()


ROOT = _repo_root()
CENSUS = ROOT / "never_to_be_pushed" / "discovery" / "surface-census.md"
PAGES = ("home", "nfl", "ncaaf", "nba", "wnba")

# RL_BUILD Part 3: | Class | Detected | Instances (where) | Capture strategy chosen | ...
# Columns are found by header name, never by position; older censuses call the
# evidence column "Evidence" and some carry a leading "#" column.
CLASS_COL = re.compile(r"^class$", re.IGNORECASE)
DETECTED_COL = re.compile(r"^detected$", re.IGNORECASE)
EVIDENCE_COL = re.compile(r"^(instances|evidence)\b", re.IGNORECASE)
SEPARATOR = re.compile(r"^\|?\s*:?-{3,}")

NEGATIVE = re.compile(r"\bNOT DETECTED\b", re.IGNORECASE)
# A whole phrase naming every page. A bare "all five" is not enough: "not all five
# pages" contains it, and so does "all five columns".
BLANKET = re.compile(r"\b(all (five|5) (in-scope )?pages|every in-scope page)\b", re.IGNORECASE)
# A blanket phrase qualified by any of these words in front of it does not claim all pages.
QUALIFIER = re.compile(r"\b(not|never|no|without|except|only|but|n't)\W*(\w+\W+){0,2}$", re.IGNORECASE)


def cells_of(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def plain(cell: str) -> str:
    return re.sub(r"[*_`]", "", cell).strip()


def blanket_claim(evidence: str) -> bool:
    for m in BLANKET.finditer(evidence):
        if not QUALIFIER.search(evidence[max(0, m.start() - 40):m.start()]):
            return True
    return False


def check(text: str, where: str = "surface-census.md") -> tuple[int, list[str]]:
    """Return (verdicts examined, failures) for a census document."""
    failures: list[str] = []
    checked = 0
    cols: dict[str, int] | None = None
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.lstrip().startswith("|"):
            cols = None  # a table ended; the next one brings its own header
            continue
        if SEPARATOR.match(line.strip()):
            continue
        cells = cells_of(line)
        heads = [plain(c) for c in cells]
        idx = {
            "class": next((i for i, h in enumerate(heads) if CLASS_COL.match(h)), -1),
            "detected": next((i for i, h in enumerate(heads) if DETECTED_COL.match(h)), -1),
            "evidence": next((i for i, h in enumerate(heads) if EVIDENCE_COL.match(h)), -1),
        }
        if min(idx.values()) >= 0:
            cols = idx
            continue
        if cols is None:
            # A table row with no recognised Class / Detected / Instances header above it.
            # Skipping it would let a census in an unexpected shape pass having checked
            # nothing, so a negative verdict in such a table is itself a failure.
            if NEGATIVE.search(line):
                failures.append(f"{where}:{lineno}  NOT DETECTED row in a table with no "
                                f"recognised Class / Detected / Instances (or Evidence) header")
            continue
        if max(cols.values()) >= len(cells):
            continue
        if not NEGATIVE.search(cells[cols["detected"]]):
            continue
        checked += 1
        name = plain(cells[cols["class"]])
        evidence = cells[cols["evidence"]]
        named = [p for p in PAGES if re.search(rf"\b{p}\b", evidence, re.IGNORECASE)]
        if not blanket_claim(evidence) and len(named) < len(PAGES):
            missing = [p for p in PAGES if p not in named]
            failures.append(
                f"{where}:{lineno}  '{name[:40]}' is NOT DETECTED but "
                f"cites only {named or 'no page'} — missing {missing}"
            )
    return checked, failures


def main() -> int:
    if not CENSUS.exists():
        write_check_record(NAME, ran=False, count=0, status="skipped",
                           reason="no discovery/surface-census.md", root=ROOT)
        print("check_surface_census: no discovery/surface-census.md — skipped")
        return 0

    text = CENSUS.read_text()
    checked, failures = check(text, str(CENSUS.relative_to(ROOT)))
    if checked == 0 and not failures and NEGATIVE.search(text):
        failures.append(f"{CENSUS.relative_to(ROOT)}: NOT DETECTED appears but no verdict row "
                        f"was recognised; the census schema is not one this gate can read")
    print(f"check_surface_census: {checked} NOT DETECTED verdict(s) examined")
    for f in failures:
        print(f"    {f}")
    if failures:
        write_check_record(NAME, ran=True, count=checked, status="fail",
                           reason=f"{len(failures)} unevidenced verdict(s)", root=ROOT)
        print(f"\nFAIL: {len(failures)} negative verdict(s) not evidenced on every in-scope page")
        return 1
    write_check_record(NAME, ran=True, count=checked, status="pass", root=ROOT)
    print("PASS: every NOT DETECTED verdict is evidenced across all in-scope pages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
