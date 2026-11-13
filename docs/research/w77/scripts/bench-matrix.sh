#!/bin/sh
# W77: bench matrix, one page per scene. usage: bench-matrix.sh <port> <outDir> scene:pose ...
PORT=$1; OUT=$2; shift 2
D=$(cd "$(dirname "$0")" && pwd)
PIN='s.hitColorFilter=cone&s.mirrorBiasCompensate=1&s.mirrorBias=0.5'
for sp in "$@"; do
  scene=${sp%%:*}; pose=${sp##*:}
  echo "=== $scene $pose $(date +%H:%M:%S)"
  node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/bench.html?manual&scene=$scene&pose=$pose&size=960x540&left=ours-rt&right=pathtraced&$PIN" "$OUT" "$D/bench-matrix.js" "$(cat "$D/cells.js"); const POSE='$pose'; const TAG='$scene';"
done
