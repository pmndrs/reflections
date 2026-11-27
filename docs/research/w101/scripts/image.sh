#!/bin/sh
# W101: image.js (rest flicker + image change, occ 4 vs 0 alternating in-page) on the ssr page / showcase, 960x540.
# usage: image.sh <port> <outFile> <rt 0|1> <runs per config> scene ...
PORT=$1; OUT=$2; RT=$3; RUNS=$4; shift 4
D=$(cd "$(dirname "$0")" && pwd)
for scene in "$@"; do
  echo "=== $scene rt=$RT $(date +%H:%M:%S)"
  case $scene in
    mirrorWall|contact) URL="http://127.0.0.1:$PORT/ssr/?manual&scene=$scene$([ "$RT" = 1 ] && echo '&rt=1')"; PRE="const TAG='$scene rt=$RT'; const RUNS=$RUNS;" ;;
    *) URL="http://127.0.0.1:$PORT/showcase/index.html?manual&w=960&h=540&scene=$scene"; PRE="const TAG='$scene rt=$RT'; const SHOWCASE=1; const RT=$RT; const RUNS=$RUNS;" ;;
  esac
  node "$D/drive.mjs" "$URL" "${TMPDIR:-/tmp}/w101-unused" "$D/image.js" "$PRE" | tee -a "$OUT"
done
