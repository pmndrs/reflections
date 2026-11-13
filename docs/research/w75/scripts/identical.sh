#!/bin/sh
# W75 (copy of W74): default-is-identical captures (docs/research/w74/scripts/identical.js) for one source tree: run on the baseline
# sources and on the branch, then compare with identical.py. Deterministic setup: frameIndex fixed and FFX's occupancy
# exit off (with it on, which rays share a subgroup follows the atomic append order, so two runs of one build differ).
# usage: identical.sh <tag> [port]
TAG=$1; PORT=${2:-5447}
D=$(dirname "$0")
PRE="const FRAME_INDEX=5; const SSR={minTraversalOccupancy:0};"
SC="const SCENES=['offscreen','contact','mirrorWall','facingMirrors','moving'];"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off&denoise=0" out/w75/ident "$D/identical.js" "const TAG='$TAG-raw'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off" out/w75/ident "$D/identical.js" "const TAG='$TAG-dn'; $SC $PRE"
node "$D/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540" out/w75/ident "$D/identical.js" "const TAG='$TAG-car'; const SHOWCASE=true; const SCENES=['carConcept']; $PRE"
