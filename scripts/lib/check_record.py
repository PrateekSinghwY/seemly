"""Python twin of check-record.mjs: same record shape, same directory.

Kept as a mirror, not a second design: change both or neither.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

CHECKS_DIR = Path("never_to_be_pushed") / "discovery" / "checks"
STATUSES = {"pass", "fail", "skipped"}


def write_check_record(
    name: str, *, ran: bool, count: int, status: str, reason: str | None = None, root: Path | None = None
) -> None:
    if status not in STATUSES:
        raise ValueError(f"check record {name}: unknown status {status}")
    if status == "skipped" and ran:
        raise ValueError(f"check record {name}: a skip cannot have run")
    out = (root or Path.cwd()) / CHECKS_DIR
    out.mkdir(parents=True, exist_ok=True)
    record = {"ran": ran, "count": count, "status": status, "reason": reason,
              "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    (out / f"{name}.json").write_text(json.dumps(record, indent=2) + "\n")
