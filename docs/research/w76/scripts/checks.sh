#!/bin/sh
# W76: the check sections, one at a time, into out/w76/checks/<section>.txt; a summary line per section.
cd "$(dirname "$0")/../../../.."
mkdir -p out/w76/checks
for s in ${SECTIONS:-sssr-core ssr hybrid ssr-rt ssr-rt-bvh showcase regressions bench ssr-exp-metrics pixi3d babylon}; do
  REFLECTIONS_PORT=5448 DENOISER_REPO=/Users/dex/Developer/Denoiser-w53-rebase pnpm check -- --only $s > out/w76/checks/$s.txt 2>&1
  echo "$s: $(grep -c '\[PASS\]' out/w76/checks/$s.txt) pass, $(grep -c '\[FAIL\]' out/w76/checks/$s.txt) fail, $(tail -1 out/w76/checks/$s.txt)" >> out/w76/checks/summary.txt
done
echo finished >> out/w76/checks/summary.txt
