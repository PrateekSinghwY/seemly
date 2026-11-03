"""Where a project's video tree lives, for every seemly-video script.

The scripts live in the skill; the data lives in the project you run them from:
  project     $SEEMLY_PROJECT, else the git top level of the current directory
  video root  $SEEMLY_VIDEO_ROOT, else an existing <project>/docs/research/*/07_video,
              else <project>/research/video
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def project() -> Path:
    if os.environ.get("SEEMLY_PROJECT"):
        return Path(os.environ["SEEMLY_PROJECT"]).resolve()
    top = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False
    ).stdout.strip()
    return Path(top) if top else Path.cwd()


def video_root(proj: Path | None = None) -> Path:
    env = os.environ.get("SEEMLY_VIDEO_ROOT") or os.environ.get("UKG_VIDEO_ROOT")
    if env:
        return Path(env).resolve()
    proj = proj or project()
    found = sorted(proj.glob("docs/research/*/07_video"))
    return found[0] if found else proj / "research/video"


if __name__ == "__main__":
    print(video_root())
