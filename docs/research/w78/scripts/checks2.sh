#!/bin/sh
# W78 (after merging W77): the sections the merge needs, one after the other, PASS / FAIL / note lines only.
# usage: checks2.sh [port] (the server on that port decides which Denoiser it serves: DENOISER_REPO)
PORT=${1:-5450}
for s in preset ssr hybrid half-res brdf-prefilter showcase regressions; do
  echo "=== $s"
  REFLECTIONS_PORT=$PORT pnpm check -- --only $s 2>&1 | grep -E "\[(PASS|FAIL)\]|all checks|FAILED|checks failed|note:"
done
