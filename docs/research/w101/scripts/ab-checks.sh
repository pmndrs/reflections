#!/bin/sh
# W101: the check-based rest numbers (quickstart's "still camera" % of px, engines' "at rest" mean / max) with core's
# minTraversalOccupancy default flipped between 4 and 0 (the `?? N` in packages/core/src/sssr/sssr.ts), alternating
# A B B A A B ... so a drift over the run cancels. The served source changes; each check opens fresh pages.
# usage: ab-checks.sh <port> <outFile> <rounds> [sections, default "quickstart engines"]
PORT=$1; OUT=$2; ROUNDS=${3:-3}; SECTIONS=${4:-"quickstart engines"}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
F="$ROOT/packages/core/src/sssr/sssr.ts"
grep -q 'u\[111\] = s.minTraversalOccupancy ?? [04];' "$F" || { echo "pattern not found in $F"; exit 1; }
ORIG=$(grep -o 'u\[111\] = s.minTraversalOccupancy ?? [04];' "$F")
restore() { sed -i '' "s/u\[111\] = s.minTraversalOccupancy ?? [04];/$ORIG/" "$F"; }
trap restore EXIT INT TERM
set_occ() { sed -i '' "s/u\[111\] = s.minTraversalOccupancy ?? [04];/u[111] = s.minTraversalOccupancy ?? $1;/" "$F"; sleep 2; }
: > "$OUT"
i=0
while [ $i -lt "$ROUNDS" ]; do
  if [ $((i % 2)) -eq 0 ]; then ORDER="4 0"; else ORDER="0 4"; fi
  for occ in $ORDER; do
    set_occ $occ
    for sec in $SECTIONS; do
      echo "=== round $i occ $occ $sec $(date +%H:%M:%S)" | tee -a "$OUT"
      (cd "$ROOT" && REFLECTIONS_PORT=$PORT node scripts/run-headless.mjs --only "$sec" 2>&1) \
        | grep -E "at rest|does not flicker|FAIL|all checks passed|failed" | tee -a "$OUT"
    done
  done
  i=$((i + 1))
done
