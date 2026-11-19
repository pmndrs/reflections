#!/bin/sh
# W76: RT on, the new defaults vs the pre-W76 switch (and the cone alone vs relative thickness alone), X0 flicker metrics.
OUT=$1; PORT=${2:-5448}; D=$(dirname "$0")
for scene in contact mirrorWall offscreen; do
  for cfg in "new:" "old:&s.hitColorFilter=off&s.thicknessDepthFactor=0" "cone only:&s.thicknessDepthFactor=0" "relative only:&s.hitColorFilter=off"; do
    tag=${cfg%%:*}; qs=${cfg#*:}
    node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?scene=$scene&rt=1$qs" out/w76 "$D/flicker.js" "const TAG='$tag';" | grep '^{' >> "$OUT"
  done
done
echo finished >> "$OUT.done"
