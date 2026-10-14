#!/usr/bin/env bash
# Tiles frames from one scene's trim window into a single QA image.
#
#   qa-grid.sh [--last] scenes/s3.webm vo/beat3.mp3 qa/s3.png 0.5 2.1 4.8 …
#
# Times are scene time in seconds (the VO starts at 0.5), mapped into the raw
# recording the way assemble.mjs trims it: srcDur − (0.5 + VO + tail) + t.
# --last uses the final scene's 1.0s tail. Frames read left to right, top to
# bottom, three per row.
set -euo pipefail

tail=0.5
if [ "${1:-}" = "--last" ]; then tail=1.0; shift; fi
if [ $# -lt 4 ]; then
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
src=$1 vo=$2 out=$3
shift 3

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
offset=$(awk -v s="$(dur "$src")" -v v="$(dur "$vo")" -v t="$tail" 'BEGIN { printf "%.3f", s - (0.5 + v + t) }')

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
inputs=() i=0
for t in "$@"; do
  at=$(awk -v o="$offset" -v t="$t" 'BEGIN { printf "%.3f", o + t }')
  ffmpeg -hide_banner -loglevel error -y -ss "$at" -i "$src" -frames:v 1 \
    -vf 'scale=640:640:force_original_aspect_ratio=decrease' "$tmp/$i.png"
  echo "frame $i: scene ${t}s (source ${at}s)"
  inputs+=(-i "$tmp/$i.png")
  i=$((i + 1))
done

mkdir -p "$(dirname "$out")"
if [ "$i" -eq 1 ]; then
  cp "$tmp/0.png" "$out"
else
  IFS=x read -r w h < <(ffprobe -v error -select_streams v -show_entries stream=width,height -of csv=s=x:p=0 "$tmp/0.png")
  layout=""
  for ((k = 0; k < i; k++)); do layout+="${layout:+|}$((k % 3 * w))_$((k / 3 * h))"; done
  ffmpeg -hide_banner -loglevel error -y "${inputs[@]}" \
    -filter_complex "xstack=inputs=$i:layout=$layout:fill=black" -frames:v 1 "$out"
fi
echo "$out"
