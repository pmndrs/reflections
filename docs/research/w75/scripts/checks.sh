#!/bin/sh
# W75: the pnpm check sections the X5 run reports, one after the other, PASS / FAIL lines only.
# usage: checks.sh [port] (DENOISER_REPO from the environment)
PORT=${1:-5447}
for s in sssr-core ssr hybrid ssr-rt showcase regressions; do
  echo "=== $s"
  REFLECTIONS_PORT=$PORT pnpm check -- --only $s 2>&1 | grep -E "\[(PASS|FAIL)\]|all checks|FAILED|checks failed"
done
