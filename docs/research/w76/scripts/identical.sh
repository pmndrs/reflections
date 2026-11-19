#!/bin/sh
# W76 (from W75 / W74): "the new defaults turned back off = main, bit for bit". Captures (identical.js) of one build:
# the ssr page (5 scenes, RT on, denoiser off and on; and RT off, denoiser on) and the showcase carConcept + RT.
# On this branch pass the switch back as URL settings (examples/shared/ssrQuery.ts: from the first frame, so the
# probe bake and every frame before the capture run it too); on main nothing (its defaults).
# Deterministic setup: frameIndex fixed and FFX's occupancy exit off.
# usage: identical.sh <tag> <port> '<query suffix>'
#   sh identical.sh branch 5448 '&s.hitColorFilter=off&s.thicknessDepthFactor=0'
#   sh identical.sh main 5948 ''
TAG=$1; PORT=${2:-5448}; EXTRA=$3
D=$(dirname "$0")
OUT=out/w76/ident
PRE="const FRAME_INDEX=5; const SSR={minTraversalOccupancy:0};"
SC="const SCENES=['offscreen','contact','mirrorWall','facingMirrors','moving'];"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off&denoise=0$EXTRA" $OUT "$D/identical.js" "const TAG='$TAG-raw'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off$EXTRA" $OUT "$D/identical.js" "const TAG='$TAG-dn'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&view=final&aa=off$EXTRA" $OUT "$D/identical.js" "const TAG='$TAG-nort'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540$EXTRA" $OUT "$D/identical.js" "const TAG='$TAG-car'; const SHOWCASE=true; const SCENES=['carConcept']; $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&scene=sponza&aa=off&w=960&h=540$EXTRA" $OUT "$D/identical.js" "const TAG='$TAG-sponza'; const SHOWCASE=true; const SCENES=['sponza']; $PRE"
