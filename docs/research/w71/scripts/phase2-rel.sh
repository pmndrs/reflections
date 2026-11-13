#!/bin/sh
# W71 phase 2, #2: the relative thickness at the values that fix lineSpreadThin, on the showcase scenes (Measure vs PT).
A=${A:-5443}; OUT=$1; D=$(dirname "$0"); mkdir -p "$OUT"
B="http://127.0.0.1:$A/showcase/bench.html?manual&left=ours-denoised&right=pathtraced"
M="const METHODS = ['ours-denoised', 'ours-rt']; const SPP = 32, WARMUP = 24, FRAMES = 8;"
C="const CONFIGS = [{ name: 'k0', set: {} }, { name: 'rel0.005', set: { 's.thicknessDepthFactor': 0.005, 's.thicknessDepthMode': 'relative' } }, { name: 'rel0.01', set: { 's.thicknessDepthFactor': 0.01, 's.thicknessDepthMode': 'relative' } }, { name: 'rel0.02', set: { 's.thicknessDepthFactor': 0.02, 's.thicknessDepthMode': 'relative' } }];"
for sp in carConcept:w50 toyCar:hero chess:hero sponza:hero; do s=${sp%%:*}; p=${sp##*:}
  node "$D/drive.mjs" "$B&scene=$s&pose=$p" "$OUT" "$D/measure-bench.js" "const TAG = 'rel-$s-$p', POSE = '$p'; $M $C" > "$OUT/rel-$s.log" 2>&1
done
echo done
