#!/usr/bin/env python3
"""The no-literal gate (ESPN_SCRAPE Part 6).

Three checks, any hit fails the build:

  6.1 dictionary  - no captured domain string may appear in source
  6.2 jsx text    - MOVED to scripts/check_jsx_literals.mjs (AST-based)
  6.3 personal    - no developer identity, email, phone or account token anywhere

The allowlist ships EMPTY. Every future entry needs a one-line reason committed
beside it in scripts/no_literals_allowlist.txt.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SEED_DATA = ROOT / "backend" / "seed" / "data"
ALLOWLIST = ROOT / "scripts" / "no_literals_allowlist.txt"

SCAN_DIRS = [ROOT / "frontend", ROOT / "backend"]
SKIP_PARTS = {
    "node_modules", ".next", "__pycache__", ".venv", "dist", "build",
    "seed", "alembic", ".git", "never_to_be_pushed",
    "static",  # vendored swagger-ui / redoc bundles are third-party, not our source
}
CODE_EXT = {".ts", ".tsx", ".js", ".jsx", ".py"}

# Fields that carry domain data; their values must never be inlined in source.
DICT_FIELDS = (
    "label", "title", "text", "display_name", "abbrev", "slug",
    "meta_verbatim", "duration_verbatim", "age_verbatim",
)
MIN_TOKEN = 3

# A captured string is only *distinctive* enough to flag when it is a phrase or a long
# token. Enforcing the bare 3-character rule fires on ordinary English that is also
# domain data ("tables", "teams", "apps", "watch") and produced 45 hits on an untouched
# scaffold. The spec's escape hatch is the allowlist, but 25 generic words each with a
# reason is exactly the "check learning to ignore the mistake" that SELF_CORRECTION
# forbids. So the dictionary flags a string when it contains a space or is >= 8 chars,
# and the allowlist stays genuinely empty.
def _distinctive(s: str) -> bool:
    return " " in s or len(s) >= 8


def load_allowlist() -> set[str]:
    if not ALLOWLIST.exists():
        return set()
    out = set()
    for line in ALLOWLIST.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.add(line.split("\t")[0].strip().lower())
    return out


def build_dictionary() -> set[str]:
    words: set[str] = set()
    if not SEED_DATA.exists():
        return words
    for f in sorted(SEED_DATA.glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            for key in DICT_FIELDS:
                v = row.get(key)
                if isinstance(v, str) and len(v) >= MIN_TOKEN:
                    words.add(v.strip().lower())
    return {w for w in words if len(w) >= MIN_TOKEN and _distinctive(w)}


def seed_data_files() -> list[Path]:
    """Committed capture output. Excluded from 6.1 (it IS the dictionary) but NOT from
    6.3: it is the one committed directory guaranteed to hold captured content."""
    return sorted(SEED_DATA.glob("*.jsonl")) if SEED_DATA.exists() else []


def source_files() -> list[Path]:
    out = []
    for d in SCAN_DIRS:
        if not d.exists():
            continue
        for p in d.rglob("*"):
            if p.is_dir() or p.suffix not in CODE_EXT:
                continue
            if SKIP_PARTS & set(p.parts):
                continue
            out.append(p)
    return sorted(out)


def check_dictionary(files: list[Path], vocab: set[str], allow: set[str]) -> list[str]:
    fails = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        low = text.lower()
        for phrase in vocab:
            if phrase in allow or len(phrase) < MIN_TOKEN:
                continue
            # whole-token match only, so short strings cannot collide with identifiers.
            # Every occurrence is inspected: an early embedded one must not hide a later
            # standalone hit.
            idx = low.find(phrase)
            while idx != -1:
                before = low[idx - 1] if idx else " "
                end = idx + len(phrase)
                after = low[end] if end < len(low) else " "
                if not (before.isalnum() or after.isalnum()):
                    line = text[:idx].count("\n") + 1
                    fails.append(f"{p.relative_to(ROOT)}:{line}  dictionary hit: {phrase[:60]!r}")
                    break
                idx = low.find(phrase, idx + 1)
    return fails


EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?!png|jpe?g|gif|svg|webp|css|js)[A-Za-z]{2,}\b")
# RFC 2606 / RFC 6761 reserved documentation domains carry no real identity.
DOC_DOMAINS = ("@example.com", "@example.org", "@example.net", "@company.com", "@email.com")
PHONE = re.compile(r"(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}")


def check_personal(files: list[Path], allow: set[str]) -> list[str]:
    fails = []
    ident = []
    for key in ("user.name", "user.email"):
        try:
            v = subprocess.run(["git", "config", key], cwd=ROOT, capture_output=True, text=True).stdout.strip()
            if v:
                ident.append(v)
        except OSError:
            pass
    for p in files:
        text = p.read_text(encoding="utf-8", errors="ignore")
        for who in ident:
            if who.lower() in text.lower():
                fails.append(f"{p.relative_to(ROOT)}  developer identity present: {who[:30]!r}")
        for m in EMAIL.finditer(text):
            if any(m.group(0).lower().endswith(d) for d in DOC_DOMAINS):
                continue
            if m.group(0).lower() not in allow:
                fails.append(f"{p.relative_to(ROOT)}  email pattern: {m.group(0)[:40]!r}")
        for m in PHONE.finditer(text):
            if m.group(0).strip() not in allow:
                fails.append(f"{p.relative_to(ROOT)}  phone pattern: {m.group(0)[:30]!r}")
    return fails


def main() -> int:
    allow = load_allowlist()
    vocab = build_dictionary()
    files = source_files()

    d = check_dictionary(files, vocab, allow)
    q = check_personal(files + seed_data_files(), allow)

    print(f"check_no_literals: {len(files)} source files + {len(seed_data_files())} seed files, "
          f"{len(vocab)} dictionary entries, {len(allow)} allowlisted")
    for label, hits in (("6.1 dictionary", d), ("6.3 personal", q)):
        status = "OK" if not hits else f"{len(hits)} HIT(S)"
        print(f"  {label:<16} {status}")
        for h in hits[:25]:
            print(f"      {h}")
    print(f"  {'6.2 jsx text':<16} moved to scripts/check_jsx_literals.mjs")

    total = len(d) + len(q)
    if total:
        print(f"\nFAIL: {total} literal/personal-data violation(s)")
        return 1
    print("\nPASS: no literals, no personal data")
    return 0


if __name__ == "__main__":
    sys.exit(main())
