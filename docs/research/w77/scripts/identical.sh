#!/bin/sh
# W77 (copy of W75 / W74): default-is-identical captures (docs/research/w74/scripts/identical.js) for one source tree: run on the baseline
# sources and on the branch, then compare with identical.py. Deterministic setup: frameIndex fixed and FFX's occupancy
# exit off (with it on, which rays share a subgroup follows the atomic append order, so two runs of one build differ).
# usage: identical.sh <tag> [port]
TAG=$1; PORT=${2:-5449}
D=$(dirname "$0")
PRE="const FRAME_INDEX=5; const SSR={minTraversalOccupancy:0};"
SC="const SCENES=['offscreen','contact','mirrorWall','facingMirrors','moving'];"
node "$D/../../w75/scripts/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off&denoise=0" /private/tmp/claude-502/-Users-dex-Developer-reflections/03b11d8b-c91d-4f6a-b733-ada1302bb4d5/scratchpad/ident "$D/identical.js" "const TAG='$TAG-raw'; $SC $PRE"
node "$D/../../w75/scripts/drive.mjs" "http://127.0.0.1:$PORT/ssr/?manual&rt=1&view=final&aa=off" /private/tmp/claude-502/-Users-dex-Developer-reflections/03b11d8b-c91d-4f6a-b733-ada1302bb4d5/scratchpad/ident "$D/identical.js" "const TAG='$TAG-dn'; $SC $PRE"
node "$D/../../w75/scripts/drive.mjs" "http://127.0.0.1:$PORT/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540" /private/tmp/claude-502/-Users-dex-Developer-reflections/03b11d8b-c91d-4f6a-b733-ada1302bb4d5/scratchpad/ident "$D/identical.js" "const TAG='$TAG-car'; const SHOWCASE=true; const SCENES=['carConcept']; $PRE"
