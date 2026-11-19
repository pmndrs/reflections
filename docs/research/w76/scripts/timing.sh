#!/bin/sh
# W76: GPU ms of the new defaults vs pre-W76 (timing.js) on carConcept, Sponza (showcase) and mirrorWall (ssr page),
# RT on, AA off, at 1080p and 1440p. One line of JSON per page to $OUT.
# usage: sh timing.sh <out.jsonl> [port]
OUT=$1; PORT=${2:-5448}; D=$(dirname "$0")
for size in "w=1920&h=1080" "w=2560&h=1440"; do
  node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&rt=1&aa=off&scene=carConcept&$size" out/w76 "$D/timing.js" "const SHOWCASE=true;" | grep '^{' >> "$OUT"
  node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&rt=1&aa=off&scene=sponza&$size" out/w76 "$D/timing.js" "const SHOWCASE=true;" | grep '^{' >> "$OUT"
  node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&timing&rt=1&aa=off&$size" out/w76 "$D/timing.js" "const SCENE='mirrorWall';" | grep '^{' >> "$OUT"
done
echo finished >> "$OUT.done"
