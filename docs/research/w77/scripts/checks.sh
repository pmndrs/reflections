#!/bin/sh
# W77: the pnpm check sections the brief asks for, one after the other, PASS / FAIL lines only.
# usage: checks.sh [port] (DENOISER_REPO from the environment)
PORT=${1:-5449}
for s in preset ssr hybrid half-res showcase bench regressions; do
  echo "=== $s $(date +%H:%M:%S)"
  REFLECTIONS_PORT=$PORT pnpm check -- --only $s 2>&1 | grep --line-buffered -E "\[(PASS|FAIL)\]|all checks|FAILED|checks failed|passed|failed"
done
echo "=== end $(date +%H:%M:%S)"
