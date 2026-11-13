#!/bin/sh
# W78 (W74's): default-is-identical captures for one source tree, with the denoiser on (the denoised output hashed
# too). Run on this branch (Denoiser w78-brdf-prefilter) and on main + Denoiser main, then compare the logged hashes
# and the PNGs (identical.py). usage: identical.sh <tag> [port] [outDir]
TAG=$1; PORT=${2:-5450}; OUT=${3:-out/w78/ident}
D=$(dirname "$0")
PRE="const FRAME_INDEX=5; const SSR={minTraversalOccupancy:0};"
SC="const SCENES=['offscreen','contact','mirrorWall','facingMirrors','moving'];"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off" "$OUT" "$D/identical.js" "const TAG='$TAG-dn'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540" "$OUT" "$D/identical.js" "const TAG='$TAG-car'; const SHOWCASE=true; const SCENES=['carConcept']; $PRE"
