#!/bin/sh
# W71 phase 2, #1 quadBaseRotation: X0's rest drift, orbit flicker, 2x2 energy (examples/ssr and the bench), fixed run first and last.
A=${A:-5443}; OUT=$1; D=$(dirname "$0"); mkdir -p "$OUT"
C="const CONFIGS=[{name:'fixed',set:{}},{name:'frame',set:{quadBaseRotation:'frame'}},{name:'pattern',set:{quadBaseRotation:'pattern'}},{name:'fixed2',set:{}}]; const WHICH=['restDrift','orbitFlicker','quadEnergy']; const OPTS={};"
for u in "contact" "contact&aa=off" "contact&upscale=quality" "mirrorWall" "offscreen" "rooms"; do
  tag=rot-$(echo "$u" | tr '&=' '__')
  node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?scene=$u" "$OUT" "$D/p2-ssr.js" "const TAG='$tag'; $C" > "$OUT/$tag.log" 2>&1
done
CB="const CONFIGS=[{name:'fixed',set:{}},{name:'frame',set:{'s.quadBaseRotation':'frame'}},{name:'pattern',set:{'s.quadBaseRotation':'pattern'}},{name:'fixed2',set:{}}];"
for sp in carConcept:w50 chess:hero; do s=${sp%%:*}; p=${sp##*:}
  node "$D/drive.mjs" "http://127.0.0.1:$A/showcase/bench.html?manual&scene=$s&pose=$p&left=ours-denoised&right=ours-rt" "$OUT" "$D/p2-bench.js" "const TAG='rot-bench-$s'; $CB const PAGE={method:'ours-denoised',pose:'$p',which:['restDrift','orbitFlicker','quadEnergy']};" > "$OUT/rot-bench-$s.log" 2>&1
done
# D3663: the source-edge stair step with the denoiser's hit source on (W53), ours + RT on carConcept w50: 2x2 energy and Measure on the lip
node "$D/drive.mjs" "http://127.0.0.1:$A/showcase/bench.html?manual&scene=carConcept&pose=w50&left=ours-rt&right=pathtraced&hitSource=1" "$OUT" "$D/measure-bench.js" "const TAG='rot-hitsource-carConcept', POSE='w50'; const METHODS=['ours-rt']; const SPP=32, WARMUP=24, FRAMES=8; const CONFIGS=[{name:'fixed',set:{}},{name:'pattern',set:{'s.quadBaseRotation':'pattern'}},{name:'sameSurface',set:{'s.quadCopy':'sameSurface'}},{name:'sameSurface+pattern',set:{'s.quadCopy':'sameSurface','s.quadBaseRotation':'pattern'}}];" > "$OUT/rot-hitsource.log" 2>&1
echo done
