#!/bin/zsh
# W110 (after W107's flick.sh): one flicker run (scripts/flicker.mjs) in this worktree on port 5432, copied to
# docs/research/w110/data. Configs: 'base' = the W110 maps off (alpha test, roughness / metalness, emissive: their means,
# as before W110), 'on' = the defaults. flick.sh <label> [configs JSON] [scenes]
cd "$(dirname "$0")/../../../.."
OFF='rtAlpha=0&rtRoughMetal=0&rtEmissiveMap=0'
DEF_CONFIGS='[{"label":"base","q":"'$OFF'","url":"rt=1&'$OFF'"},{"label":"on","q":"","url":"rt=1"}]'
export REFLECTIONS_PORT=5432 FLICKER_LABEL=$1 FLICKER_REPEAT=2 FLICKER_CONFIGS=${2:-$DEF_CONFIGS}
export FLICKER_SCENES=${3:-'ssr:moving,ssr:contact,bench:fenceFloor@down/ours-rt,bench:sponza@low/ours-rt,bench:sponza@hero/ours-rt,bench:toyCar@hero/ours-rt,bench:carConcept@w50/ours-rt,bench:chess@hero/ours-rt'}
CHECK_SECTION_BUDGET_MS=10800000 pnpm check -- --only flicker 2>&1 | tail -4
cp out/flicker-$1.json docs/research/w110/data/
