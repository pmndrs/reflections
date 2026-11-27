#!/bin/sh
# W101: 1080p GPU ms, minTraversalOccupancy 4 vs 0 alternating inside each page (timing.js), loop stopped.
# usage: timing.sh <port> <outFile> <rt 0|1> [preset] scene ...   (mirrorWall / contact: ssr page; sponza / carConcept: showcase)
PORT=$1; OUT=$2; RT=$3; shift 3
PRESET=""; case $1 in default|performance) PRESET=$1; shift ;; esac
D=$(cd "$(dirname "$0")" && pwd)
for scene in "$@"; do
  echo "=== $scene rt=$RT ${PRESET:-default} $(date +%H:%M:%S)"
  PP=""; [ -n "$PRESET" ] && PP="const PRESET='$PRESET';"
  case $scene in
    mirrorWall|contact) URL="http://127.0.0.1:$PORT/ssr/?manual&timing&gpuTime&w=1920&h=1080&scene=$scene$([ "$RT" = 1 ] && echo '&rt=1')$([ "$PRESET" = performance ] && echo '&res=half')"; PRE="const TAG='$scene'; const RT=$RT;" ; PP="" ;;
    *) URL="http://127.0.0.1:$PORT/showcase/index.html?manual&gpuTime&w=1920&h=1080&scene=$scene"; PRE="const TAG='$scene'; const SHOWCASE=1; const RT=$RT; $PP" ;;
  esac
  node "$D/drive.mjs" "$URL" "${TMPDIR:-/tmp}/w101-unused" "$D/timing.js" "$PRE" | tee -a "$OUT"
done
