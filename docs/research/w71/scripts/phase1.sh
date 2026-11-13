#!/bin/sh
# W71 phase 1 measurements (bench Measure vs the path tracer). sh phase1.sh <outDir> ; port $A (5443)
A=${A:-5443}; OUT=$1; D=$(dirname "$0"); mkdir -p "$OUT"
B="http://127.0.0.1:$A/showcase/bench.html?manual&left=ours-denoised&right=pathtraced&aa=off"
M="const METHODS = ['ours-denoised', 'ours-rt']; const SPP = 32, WARMUP = 24, FRAMES = 8;"
# #1 quadBaseRotation (and with quadCopy sameSurface)
node "$D/drive.mjs" "$B&scene=carConcept&pose=w50" "$OUT" "$D/measure-bench.js" "const TAG = 'rot-carConcept-w50', POSE = 'w50'; $M const CONFIGS = [
  { name: 'fixed', set: {} }, { name: 'frame', set: { 's.quadBaseRotation': 'frame' } }, { name: 'pattern', set: { 's.quadBaseRotation': 'pattern' } },
  { name: 'sameSurface', set: { 's.quadCopy': 'sameSurface' } }, { name: 'sameSurface+pattern', set: { 's.quadCopy': 'sameSurface', 's.quadBaseRotation': 'pattern' } }];" > "$OUT/rot-carConcept.log" 2>&1
node "$D/drive.mjs" "$B&scene=toyCar&pose=hero&floorRoughness=0.2" "$OUT" "$D/measure-bench.js" "const TAG = 'rot-toyCar-hero', POSE = 'hero'; $M const CONFIGS = [
  { name: 'fixed', set: {} }, { name: 'frame', set: { 's.quadBaseRotation': 'frame' } }, { name: 'pattern', set: { 's.quadBaseRotation': 'pattern' } }];" > "$OUT/rot-toyCar.log" 2>&1
# #2 thicknessDepthFactor
for sp in toyCar:hero carConcept:w50 sponza:courtyard; do s=${sp%%:*}; p=${sp##*:}
node "$D/drive.mjs" "$B&scene=$s&pose=$p" "$OUT" "$D/measure-bench.js" "const TAG = 'thick-$s-$p', POSE = '$p'; $M const CONFIGS = [
  { name: 'k0', set: {} }, { name: 'k0.002', set: { 's.thicknessDepthFactor': 0.002 } }, { name: 'k0.005', set: { 's.thicknessDepthFactor': 0.005 } },
  { name: 'k0.01', set: { 's.thicknessDepthFactor': 0.01 } }, { name: 'k0.02', set: { 's.thicknessDepthFactor': 0.02 } },
  { name: 'rel0.025', set: { 's.thicknessDepthFactor': 0.025, 's.thicknessDepthMode': 'relative' } }, { name: 'rel0.05', set: { 's.thicknessDepthFactor': 0.05, 's.thicknessDepthMode': 'relative' } }];" > "$OUT/thick-$s.log" 2>&1
done
# #4 historyEdgeConfidence: pan on examples/ssr
for s in mirrorWall facingMirrors; do
node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?manual&scene=$s&rt=1&denoise=1&aa=off&hit=final&reshade=off" "$OUT" "$D/edgepan.js" "const TAG = 'pan-$s', RATE = 0.01, FRAMES = 30, DIR = 1;" > "$OUT/pan-$s.log" 2>&1
done
echo done
