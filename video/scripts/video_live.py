"""Live-view events for seemly-video, in the orchestrator's events.jsonl format.

`run.mjs watch --dir <video root>/frames_raw/_live` draws them as a tree: start -> one
node per recording -> one node per screen -> one node per state, each recording going
from "exploring" (being deduped) to explored, with errors on the node that raised them.
The file sits under frames_raw/ (gitignored); it holds slugs and labels, never pixels.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

_dir: Path | None = None


def init(raw_dir: Path) -> None:
    global _dir
    _dir = raw_dir / "_live"
    _dir.mkdir(parents=True, exist_ok=True)


def emit(type_: str, **payload) -> None:
    if _dir is None:
        return
    ev = {
        "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "type": type_,
        **payload,
        "agent": os.environ.get("SEEMLY_AGENT") or "seemly-video",
    }
    with (_dir / "events.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(ev) + "\n")


def node(id_: str, label: str, kind: str, parent: str | None, status: str = "frontier") -> None:
    emit("node.added", node={"id": id_, "label": label, "kind": kind, "status": status, "entry": parent is None})
    if parent:
        emit("edge.added", edge={"id": f"{parent}>{id_}", "from": parent, "to": id_, "kind": "contains", "element": {"role": kind, "name": label}})


def status(id_: str, to: str, detail: str | None = None) -> None:
    emit("node.status", id=id_, to=to, detail=detail)


def video_started(slug: str) -> None:
    node(f"v:{slug}", slug, "page", None)
    status(f"v:{slug}", "expanding")
    emit("walker.at", node=f"v:{slug}", element="dedupe")


def video_done(slug: str, summary: dict) -> None:
    status(f"v:{slug}", "closed", f"{summary.get('kept', '?')} kept, {summary.get('survival_pct', '?')}% survival")


def video_failed(slug: str, error: BaseException) -> None:
    emit("walker.error", node=f"v:{slug}", element="dedupe", kind=type(error).__name__, detail=str(error)[:300])
    status(f"v:{slug}", "gap", str(error)[:300])


def states(states_: dict) -> None:
    """One node per screen under the first recording it appears in, one per state under it."""
    seen: set[str] = set()
    for key, s in states_.items():
        screen = s.get("screen_slug") or key.split("#")[0]
        sources = s.get("sources") or []
        sid = f"s:{screen}"
        if sid not in seen:
            seen.add(sid)
            node(sid, screen, "page", f"v:{sources[0]}" if sources else None, "closed")
        for extra in sources[1:]:
            emit("edge.added", edge={"id": f"v:{extra}>{sid}", "from": f"v:{extra}", "to": sid, "kind": "contains", "element": {}})
        node(f"st:{key}", s.get("state") or "rest", "state", sid, "closed")
    emit("walker.done", frontier=0)
