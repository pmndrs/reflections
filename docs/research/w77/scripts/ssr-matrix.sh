#!/bin/sh
# W77: examples/ssr matrix (mirrorWall, contact): one page per scene x upscale ratio, both presets inside it.
# usage: ssr-matrix.sh <port> <outDir> scene ...
PORT=$1; OUT=$2; shift 2
D=$(cd "$(dirname "$0")" && pwd)
for scene in "$@"; do
  for up in native quality performance; do
    echo "=== $scene $up $(date +%H:%M:%S)"
    node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?scene=$scene&rt=1&upscale=$up" "$OUT" "$D/ssr-matrix.js" "const TAG='$scene-$up';"
  done
done
