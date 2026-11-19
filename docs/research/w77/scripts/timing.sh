#!/bin/sh
# W77: 1080p GPU ms per preset x upscale ratio. One page per ratio (presets alternate inside it), ratios in ABBA order
# (native, quality, performance, performance, quality, native) so a drift over the run cancels.
# usage: timing.sh <port> <outDir> scene ...   (carConcept / chess / sponza: showcase; mirrorWall / contact: ssr page)
PORT=$1; OUT=$2; shift 2
D=$(cd "$(dirname "$0")" && pwd)
for scene in "$@"; do
  for up in native quality performance performance quality native; do
    echo "=== $scene $up $(date +%H:%M:%S)"
    case $scene in
      mirrorWall|contact) URL="http://127.0.0.1:$PORT/ssr/?manual&aa=upscaler&timing&gpuTime&rt=1&w=1920&h=1080&scene=$scene&upscale=$up"; PRE="const TAG='$scene $up';" ;;
      *) URL="http://127.0.0.1:$PORT/showcase/index.html?manual&gpuTime&w=1920&h=1080&scene=$scene&upscale=$up"; PRE="const TAG='$scene $up'; const SHOWCASE=1;" ;;
    esac
    node "$D/drive.mjs" "$URL" "$OUT" "$D/timing.js" "$PRE"
  done
done
