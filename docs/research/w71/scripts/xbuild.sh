#!/bin/sh
# W71: this branch (port $A, default 5443) vs main 0abd154 (port $B, out/w71-base) on examples/ssr, settings absent.
# sh xbuild.sh <outDir>
A=${A:-5443}; B=${B:-5943}; OUT=$1; D=$(dirname "$0")
mkdir -p "$OUT"
for cfg in "mirrorWall&rt=0&reshade=reshade" "mirrorWall&rt=1&reshade=reshade" "contact&rt=1&reshade=off" "facingMirrors&rt=0&reshade=off" "rooms&rt=1&reshade=reshade"; do
  tag=$(echo "$cfg" | tr '&=' '__')
  for side in "a:$A" "a2:$A" "b:$B"; do
    name=${side%%:*}; port=${side##*:}
    node "$D/drive.mjs" "http://127.0.0.1:$port/ssr/?manual&scene=$cfg&denoise=1&aa=off&hit=final" "$OUT" "$D/xbuild-ssr.js" "const TAG = '$tag-$name';" | grep -v '^saved'
  done
  python3 "$D/imgdiff.py" "$OUT/$tag-a.png" "$OUT/$tag-a2.png" "$OUT/$tag-a.png" "$OUT/$tag-b.png"
done
