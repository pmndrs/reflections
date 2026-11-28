#!/bin/zsh
# W107: one flicker run (scripts/flicker.mjs) in this worktree on port 5429, copied to docs/research/w107/data.
# flick.sh <label> '<configs JSON>' [scenes]
cd "$(dirname "$0")/../../../.."
export REFLECTIONS_PORT=5429 FLICKER_LABEL=$1 FLICKER_REPEAT=2 FLICKER_CONFIGS=$2
export FLICKER_SCENES=${3:-'ssr:contact,ssr:mirrorWall,bench:cubeFloor/ours-rt,bench:edgesFloor/ours-rt,bench:plateFloor/ours-rt,bench:carConcept@w50/ours-rt,bench:carConcept@hero/ours-rt,bench:sponza@hero/ours-rt'}
CHECK_SECTION_BUDGET_MS=7200000 pnpm check -- --only flicker 2>&1 | tail -4
cp out/flicker-$1.json docs/research/w107/data/
