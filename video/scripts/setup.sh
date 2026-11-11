#!/usr/bin/env bash
# seemly-video preflight. Run from the project root; safe to re-run.
#   bash ~/.claude/skills/seemly-video/scripts/setup.sh [--selftest]
# Installs missing tools (Homebrew on macOS), makes the project's video tree, gitignores
# everything that must stay local, creates an empty pii.json, and checks Playwright.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
ok()  { printf '  ok    %s\n' "$1"; }
bad() { printf '  FIX   %s\n' "$1"; fail=1; }

need() {  # need <command> <brew formula>
  if command -v "$1" >/dev/null 2>&1; then ok "$1"; return; fi
  if command -v brew >/dev/null 2>&1; then
    brew install "$2" >/dev/null 2>&1 && ok "$1 (installed)" && return
  fi
  bad "$1 missing: install $2 (macOS: brew install $2)"
}
echo "tools"
need ffmpeg ffmpeg
need ffprobe ffmpeg
need tesseract tesseract
need uv uv
need node node
need git git

PROJ="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
VROOT="$(cd "$PROJ" && python3 "$HERE/video_paths.py")"
echo "project  $PROJ"
echo "video    $VROOT"
mkdir -p "$VROOT/videos" "$VROOT/frames_raw" "$VROOT/frames_curated"
touch "$VROOT/videos/.gitkeep" "$VROOT/frames_raw/.gitkeep" "$VROOT/frames_curated/.gitkeep"
[ -f "$VROOT/frames_raw/pii.json" ] || echo '{"names": [], "emails": [], "ids": [], "hosts": []}' >"$VROOT/frames_raw/pii.json"

rel="${VROOT#"$PROJ"/}"
gi="$PROJ/.gitignore"
touch "$gi"
for d in videos frames_raw frames_curated; do
  grep -qxF "$rel/$d/*" "$gi" || printf '%s\n!%s\n' "$rel/$d/*" "$rel/$d/.gitkeep" >>"$gi"
done
leak="$(cd "$PROJ" && git ls-files "$rel/videos" "$rel/frames_raw" "$rel/frames_curated" | grep -v '\.gitkeep$' || true)"
[ -z "$leak" ] && ok "videos, raw and curated frames are gitignored" || bad "already tracked, untrack them: $leak"

echo "verify (frame_diff needs Playwright in the project)"
if (cd "$PROJ" && node -e "require.resolve('playwright')" >/dev/null 2>&1); then ok "playwright"
else bad "playwright missing: cd $PROJ && pnpm add -D playwright && pnpm exec playwright install chromium"; fi

echo "storage (leaked test DBs and scratch copies are swept; test code must not leak)"
(cd "$PROJ" && python3 "$HERE/video_storage.py" clean | tail -1 | sed 's/^/  ok    storage /')
if (cd "$PROJ" && python3 "$HERE/video_storage.py" check-tests >/tmp/seemly-check-tests.$$ 2>&1); then ok "test code clones and cleans its DB copies"
else bad "test code leaks DB copies, fix each line (SKILL.md, Storage):"; sed 's/^/          /' /tmp/seemly-check-tests.$$; fi
rm -f /tmp/seemly-check-tests.$$

if [ "${1:-}" = "--selftest" ]; then
  echo "selftest"
  (cd "$PROJ" && uv run --quiet "$HERE/dedupe_frames.py" selftest) && ok "planted-event selftest" || bad "selftest failed (output above)"
  python3 "$HERE/video_storage.py" selftest && ok "storage selftest" || bad "storage selftest failed (output above)"
fi
[ $fail = 0 ] && echo "setup OK" || { echo "setup INCOMPLETE: fix the FIX lines and re-run"; exit 1; }
