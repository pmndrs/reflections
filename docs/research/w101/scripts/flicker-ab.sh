#!/bin/sh
# W101: `pnpm check -- --only flicker` (scripts/flicker.mjs, X0's metrics on its standard scenes), one run per config
# (the check's 10 min limit), minTraversalOccupancy set per page (ssr page settings / bench `s.` key), order 4 0 0 4 4 0.
# usage: flicker-ab.sh <port> <outDir>
PORT=$1; OUTD=$2
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
mkdir -p "$OUTD"
n=0
for occ in 4 0 0 4 4 0; do
  n=$((n + 1))
  echo "=== run $n occ $occ $(date +%H:%M:%S)"
  CFG="[{\"label\":\"occ$occ\",\"q\":\"s.minTraversalOccupancy=$occ\",\"ssr\":{\"minTraversalOccupancy\":$occ}}]"
  (cd "$ROOT" && OUT="$OUTD" FLICKER_LABEL="occ$occ-$n" FLICKER_CONFIGS="$CFG" REFLECTIONS_PORT=$PORT node scripts/run-headless.mjs --only flicker 2>&1) | grep -E "\] occ|FAIL|PASS|failed|timed out"
done
