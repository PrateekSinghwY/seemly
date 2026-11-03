#!/usr/bin/env python3
"""Seed files stay under the git host's per-file limit (GitHub refuses files over 100 MB): every
seed file under SEED_DIR (default `backend/seed/data`) must be at most SEED_LIMIT_MB (default 90),
so growth is caught with room to split a large table into one file per section."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(next((d for d in (_HERE / "lib", _HERE.parent / "lib") if d.is_dir()), _HERE / "lib")))
from check_record import write_check_record  # noqa: E402

LIMIT = int(os.environ.get("SEED_LIMIT_MB", "90")) * 1024 * 1024
root = Path(os.environ.get("RL_REPO", ".")) / os.environ.get("SEED_DIR", "backend/seed/data")
files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix in {".jsonl", ".json", ".csv"})
big = [(f, f.stat().st_size) for f in files if f.stat().st_size > LIMIT]
largest = max((f.stat().st_size for f in files), default=0)
print(f"check_seed_size: ran: true, {len(files)} seed files, largest {largest / 1048576:.1f} MB (limit {LIMIT // 1048576} MB)")
for f, n in big:
    print(f"  over the limit: {f} {n / 1048576:.1f} MB")
write_check_record("seed_size", ran=bool(files), count=len(files), status="fail" if big else ("pass" if files else "skipped"),
                   reason=None if files else f"no seed files under {root}")
sys.exit(1 if big else 0)
