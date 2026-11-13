#!/bin/sh
# W77: the examples/ssr readbacks for maxCandidates 1, 2, 4, 8 (server on $REFLECTIONS_PORT, default 5449). Logs to out/w77/<name>.txt
PORT=${REFLECTIONS_PORT:-5449}
run() { # name scene pose extra
  node docs/research/w77/scripts/drive.mjs "http://127.0.0.1:$PORT/ssr/?manual&scene=$2&w=960&h=540&aa=off&denoise=0$4" out/w77 docs/research/w77/scripts/ssr.js "const VALS=[1,2,4,8]; const POSE='$3';" > out/w77/$1.txt 2>&1
}
run mirrorWall mirrorWall default
run lowSphere mirrorWall lowSphere
run facingMirrors facingMirrors default
run thinPost thinPost default
run mirrorWall-rt mirrorWall default "&rt=1"
run facingMirrors-rt facingMirrors default "&rt=1"
echo finished
