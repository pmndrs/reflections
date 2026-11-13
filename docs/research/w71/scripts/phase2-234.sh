#!/bin/sh
# W71 phase 2, #2 / #3 / #4 and relative GPU ms. sh phase2-234.sh <outDir> [parts: thick graz edge time]
A=${A:-5443}; OUT=$1; shift; PARTS=${*:-thick graz edge time}; D=$(dirname "$0"); mkdir -p "$OUT"
B="http://127.0.0.1:$A/showcase/bench.html?manual&left=ours-denoised&right=pathtraced"
has() { echo " $PARTS " | grep -q " $1 "; }
if has thick; then
  # lineSpreadThin: thicker must not make the slab worse (W70 finding 3)
  node "$D/drive.mjs" "$B&scene=lineSpreadThin" "$OUT" "$D/p2-bench.js" "const TAG='thick-lineSpreadThin'; const CONFIGS=[{name:'k0',set:{}},{name:'k0.01',set:{'s.thicknessDepthFactor':0.01}},{name:'k0.02',set:{'s.thicknessDepthFactor':0.02}},{name:'rel0.01',set:{'s.thicknessDepthFactor':0.01,'s.thicknessDepthMode':'relative'}},{name:'rel0.025',set:{'s.thicknessDepthFactor':0.025,'s.thicknessDepthMode':'relative'}}]; const PT={fn:'lineSpread',opts:{scene:'lineSpreadThin',roughness:[0.05,0.3],methods:['ours-raw','ours-denoised','ours-rt']}};" > "$OUT/thick-lineSpreadThin.log" 2>&1
  # W9 streaks / stripe ratio on mirrorWall, misses with RT (holes go to RT)
  for u in "mirrorWall&rt=1" "contact&rt=1"; do tag=thick-ssr-$(echo "$u" | tr '&=' '__')
    node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?manual&scene=$u&aa=off" "$OUT" "$D/p2-ssr.js" "const TAG='$tag'; const CONFIGS=[{name:'k0',set:{}},{name:'k0.005',set:{thicknessDepthFactor:0.005}},{name:'k0.01',set:{thicknessDepthFactor:0.01}},{name:'k0.02',set:{thicknessDepthFactor:0.02}},{name:'rel0.025',set:{thicknessDepthFactor:0.025,thicknessDepthMode:'relative'}},{name:'rel0.05',set:{thicknessDepthFactor:0.05,thicknessDepthMode:'relative'}}]; const WHICH=[]; const OPTS={}; const STATS=true;" > "$OUT/$tag.log" 2>&1
  done
fi
if has graz; then
  G="const CONFIGS=[{name:'g0',set:{}},{name:'g0.5',set:{'s.hitLobeFilterGrazing':0.5}},{name:'g1',set:{'s.hitLobeFilterGrazing':1}},{name:'g0 mix0',set:{'s.hitLobeFilterMixed':0}},{name:'g1 mix0',set:{'s.hitLobeFilterGrazing':1,'s.hitLobeFilterMixed':0}}];"
  node "$D/drive.mjs" "$B&scene=grazing" "$OUT" "$D/p2-bench.js" "const TAG='graz-grazing'; $G const PT={fn:'grazing',opts:{methods:['ours-denoised','ours-rt']}};" > "$OUT/graz-grazing.log" 2>&1
  node "$D/drive.mjs" "$B&scene=lineSpread" "$OUT" "$D/p2-bench.js" "const TAG='graz-lineSpread'; const CONFIGS=[{name:'g0',set:{}},{name:'g1',set:{'s.hitLobeFilterGrazing':1}}]; const PT={fn:'lineSpread',opts:{roughness:[0.05,0.15,0.3],methods:['ours-raw','ours-denoised','ours-rt'],settings:{aa:'off'}}};" > "$OUT/graz-lineSpread.log" 2>&1
fi
if has edge; then
  E="const CONFIGS=[{name:'off',set:{}},{name:'on',set:{historyEdgeConfidence:true}},{name:'off2',set:{}}]; const WHICH=['edgePan']; const OPTS={};"
  for u in facingMirrors mirrorWall offscreen; do
    node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?scene=$u&rt=1&hit=final&reshade=off" "$OUT" "$D/p2-ssr.js" "const TAG='edge-$u'; $E" > "$OUT/edge-$u.log" 2>&1
    node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?manual&scene=$u&rt=1&denoise=1&aa=off&hit=final&reshade=off" "$OUT" "$D/edgepan.js" "const TAG='edgerays-$u', RATE=0.0044, FRAMES=24, DIR=1;" > "$OUT/edgerays-$u.log" 2>&1
  done
  node "$D/drive.mjs" "http://127.0.0.1:$A/showcase/bench.html?manual&scene=carConcept&pose=w50&left=ours-rt&right=ours-denoised&reshade=off" "$OUT" "$D/p2-bench.js" "const TAG='edge-bench-carConcept'; const CONFIGS=[{name:'off',set:{}},{name:'on',set:{'s.historyEdgeConfidence':1}}]; const PAGE={method:'ours-rt',pose:'w50',which:['edgePan']};" > "$OUT/edge-bench-carConcept.log" 2>&1
fi
if has time; then
  T="const ROUNDS=3, N=30;"
  node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?manual&scene=contact&rt=1&w=1920&h=1080&aa=off" "$OUT" "$D/p2-time.js" "const TAG='time-contact-1080'; $T const CONFIGS=[{name:'default',set:{}},{name:'pattern',set:{quadBaseRotation:'pattern'}},{name:'k0.01',set:{thicknessDepthFactor:0.01}},{name:'rel0.025',set:{thicknessDepthFactor:0.025,thicknessDepthMode:'relative'}},{name:'graz1',set:{hitLobeFilterGrazing:1}}];" > "$OUT/time-contact.log" 2>&1
  node "$D/drive.mjs" "http://127.0.0.1:$A/ssr/?manual&scene=mirrorWall&rt=1&w=1920&h=1080&aa=off&hit=final&reshade=off" "$OUT" "$D/p2-time.js" "const TAG='time-mirrorWall-1080-history'; $T const CONFIGS=[{name:'default',set:{}},{name:'edge',set:{historyEdgeConfidence:true}}];" > "$OUT/time-mirrorWall.log" 2>&1
fi
echo done
