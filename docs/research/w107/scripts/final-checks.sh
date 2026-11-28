#!/bin/zsh
# W107: the closing checks on port 5429, one log per section in out/w107-final-<section>.log, a summary line each.
cd "$(dirname "$0")/../../../.."
for s in ssr-rt hybrid showcase babylon flicker catalog; do
  REFLECTIONS_PORT=5429 FLICKER_LABEL=w107-final pnpm check -- --only $s > out/w107-final-$s.log 2>&1
  echo "$s exit $? : $(grep -c '\[PASS\]' out/w107-final-$s.log) PASS, $(grep -c '\[FAIL\]' out/w107-final-$s.log) FAIL; $(grep '^sections' out/w107-final-$s.log)"
done
