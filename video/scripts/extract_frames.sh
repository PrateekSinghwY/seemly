#!/usr/bin/env bash
# Stage A1: extract raw frames from every recording in 07_video/videos/.
#
#   $V/extract_frames.sh                 # every video not yet extracted
#   $V/extract_frames.sh --force a.mp4   # re-extract one video
#
# Per video <slug> it writes, under 07_video/frames_raw/<slug>/ (gitignored):
#   f_%06d.png        uniform samples at $FPS (default 2 fps)
#   s_%06d.png        scene-change candidates, scene score > $SCENE_MIN (default 0.02)
#   e_%06d.png        event frames from the native-fps pass: settle, transient, pre
#                     (dedupe_frames.py events; every decoded frame is analysed)
#   frames.csv        file,t,source,scene_score  sorted by t (true pts_time, seconds)
#   events.json       stable runs, bursts and the event frames chosen
#   audio.wav         16 kHz mono, when the file has audio
#   subs.srt          the first subtitle track, when the file has one
#   transcript.json   speech: subtitle track if present, else local faster-whisper
#   transcript.txt      (V1; SPEECH=0 skips it; never blocks the frame work)
#   video_meta.json   source path, sha256, duration, resolution, parameters
#
# Scene candidates are extracted at a low threshold so small-area UI events
# (dropdowns, toasts) are in the pool; dedupe_frames.py only *always-keeps* the
# ones at or above 0.25. See DECISIONS.md D-004.
#
# Idempotent: a video whose frames.csv is newer than the video file is skipped.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VROOT="$(python3 "$HERE/video_paths.py")"
VIDEO_DIR="$VROOT/videos"
RAW_DIR="$VROOT/frames_raw"
FPS="${FPS:-2}"
SCENE_MIN="${SCENE_MIN:-0.02}"
SPEECH="${SPEECH:-1}"
WHISPER_MODEL="${WHISPER_MODEL:-base}"
DEDUPE="$HERE/dedupe_frames.py"

force=0
videos=()
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) videos+=("$arg") ;;
  esac
done

for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "missing $tool: brew install ffmpeg" >&2; exit 1; }
done

if [ ${#videos[@]} -eq 0 ]; then
  while IFS= read -r -d '' f; do videos+=("$f"); done < <(
    find "$VIDEO_DIR" -maxdepth 1 -type f \
      \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.webm' -o -iname '*.mkv' -o -iname '*.m4v' \) \
      -print0 | sort -z)
fi
if [ ${#videos[@]} -eq 0 ]; then
  echo "no videos in $VIDEO_DIR"; exit 0
fi

slugify() {
  basename "$1" | sed -E 's/\.[^.]+$//' | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

for v in "${videos[@]}"; do
  [ -f "$v" ] || v="$VIDEO_DIR/$v"
  [ -f "$v" ] || { echo "not found: $v" >&2; exit 1; }
  v_abs="$(cd "$(dirname "$v")" && pwd)/$(basename "$v")"
  slug="$(slugify "$v")"
  [ -n "$slug" ] || { echo "cannot derive a slug from: $v (rename the file to ASCII)" >&2; exit 1; }
  out="$RAW_DIR/$slug"

  # Two videos can slugify to the same name: never reuse or clobber another video's frames.
  if [ -f "$out/video_meta.json" ]; then
    prev_src="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("source_file",""))' "$out/video_meta.json")"
    if [ -n "$prev_src" ] && [ "$prev_src" != "$(basename "$v_abs")" ]; then
      echo "slug clash: $slug already holds frames of '$prev_src'; rename '$(basename "$v_abs")'" >&2
      exit 1
    fi
  fi

  if [ $force -eq 0 ] && [ -f "$out/frames.csv" ] && [ "$out/frames.csv" -nt "$v_abs" ]; then
    echo "skip  $slug (already extracted; --force to redo)"
    continue
  fi
  # Raw frames run ~30x the video's size: refuse up front instead of filling the disk midway.
  python3 "$HERE/video_storage.py" preflight "$v_abs" || exit 1
  rm -rf "$out"
  mkdir -p "$out"
  echo "extract $slug"

  # Run inside $out so filter file arguments never contain spaces or colons.
  (
    cd "$out"
    ffmpeg -hide_banner -nostdin -loglevel info -i "$v_abs" \
      -vf "fps=${FPS},showinfo" f_%06d.png 2> sample.log
    ffmpeg -hide_banner -nostdin -loglevel info -i "$v_abs" \
      -vf "select='gt(scene,${SCENE_MIN})',metadata=print:key=lavfi.scene_score:file=scene_scores.txt,showinfo" \
      -fps_mode vfr s_%06d.png 2> scene.log
  )

  {
    echo "file,t,source,scene_score"
    # showinfo: "n:   0 pts:      0 pts_time:0  ..."  -> f_000001.png
    grep -E 'Parsed_showinfo.* n: *[0-9]+ ' "$out/sample.log" \
      | sed -E 's/.* n: *([0-9]+) .*pts_time:([-0-9.]+).*/\1 \2/' \
      | awk '{ printf "f_%06d.png,%.3f,sample,\n", $1 + 1, $2 }'
    # metadata=print: "frame:0 pts:123 pts_time:4.1" then "lavfi.scene_score=0.31"
    if [ -f "$out/scene_scores.txt" ]; then
      awk '
        /^frame:/ { n = $1; sub("frame:", "", n); t = $3; sub("pts_time:", "", t) }
        /lavfi.scene_score=/ { s = $0; sub(".*=", "", s); printf "s_%06d.png,%.3f,scene,%s\n", n + 1, t, s }
      ' "$out/scene_scores.txt"
    fi
  } | { read -r header; echo "$header"; sort -t, -k2,2g; } > "$out/frames.csv"

  sha="$(shasum -a 256 "$v_abs" | cut -c1-16)"
  duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$v_abs")"
  # MediaRecorder .webm files often carry no duration header: ffprobe prints N/A.
  case "$duration" in
    ''|*[!0-9.]*) duration=null ;;
  esac
  wh="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$v_abs")"
  n_sample="$(grep -c ',sample,' "$out/frames.csv" || true)"
  n_scene="$(grep -c ',scene,' "$out/frames.csv" || true)"
  SLUG="$slug" SRC="$(basename "$v_abs")" SHA="$sha" DUR="$duration" WH="$wh" FPS_V="$FPS" \
  SCENE_V="$SCENE_MIN" NS="$n_sample" NC="$n_scene" python3 - "$out/video_meta.json" <<'PY'
import json, os, sys, datetime
e = os.environ
num = lambda v: None if v in ("", "null") else float(v)
json.dump({
    "slug": e["SLUG"], "source_file": e["SRC"], "sha256_16": e["SHA"],
    "duration_s": num(e["DUR"]), "resolution": e["WH"],
    "fps": num(e["FPS_V"]), "scene_min": num(e["SCENE_V"]),
    "raw_sample_frames": int(e["NS"] or 0), "raw_scene_frames": int(e["NC"] or 0),
    "extracted_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, open(sys.argv[1], "w"), indent=2)
PY
  echo "  $slug: ${duration}s ${wh}, ${n_sample} samples + ${n_scene} scene candidates"

  # Native-fps event pass: short states the 2 fps samples miss (settle/transient/pre frames).
  SEEMLY_VIDEO_ROOT="$VROOT" uv run --quiet "$DEDUPE" events "$slug" --video "$v_abs"

  # Audio and subtitles stay local; speech-to-text is the default (V1). Never fatal.
  if ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$v_abs" | grep -q .; then
    ffmpeg -hide_banner -nostdin -loglevel error -y -i "$v_abs" -vn -ac 1 -ar 16000 "$out/audio.wav" \
      || echo "  audio extraction failed; continuing without speech"
  fi
  if ffprobe -v error -select_streams s:0 -show_entries stream=index -of csv=p=0 "$v_abs" | grep -q .; then
    ffmpeg -hide_banner -nostdin -loglevel error -y -i "$v_abs" -map 0:s:0 "$out/subs.srt" \
      || echo "  subtitle track present but not extractable; using speech-to-text"
  fi
  if [ "$SPEECH" = "1" ]; then
    SEEMLY_VIDEO_ROOT="$VROOT" uv run --quiet --with faster-whisper "$DEDUPE" transcribe "$slug" \
      --model "$WHISPER_MODEL" || echo "  transcribe failed; frames are unaffected (rerun: dedupe_frames.py transcribe $slug)"
  fi
done
