#!/bin/sh
# W72 default-identical: examples/ssr (9 scenes; raw and denoised; with and without ?rt=1) and the showcase's carConcept
# (rt=1, denoised). Usage: parity-all.sh <out file> (run from docs/research/w72/scripts, server on 5444).
OUT=$1; : > $OUT
for u in 'denoise=0&aa=off&hit=current' 'aa=off' 'rt=1&denoise=0&aa=off&hit=current' 'rt=1&aa=off'; do
  echo "# ssr $u" >> $OUT
  node drive.mjs "http://127.0.0.1:5444/ssr/?manual&$u" /tmp/w72-parity parity.js 2>&1 | grep '^{' >> $OUT
done
echo "# showcase carConcept rt=1" >> $OUT
node drive.mjs 'http://127.0.0.1:5444/showcase/?manual&scene=carConcept&rt=1&aa=off&w=960&h=540' /tmp/w72-parity parity-showcase.js 2>&1 | grep '^{' >> $OUT
