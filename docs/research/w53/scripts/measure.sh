#!/bin/sh
# measure.sh TAG "<compare url query>" "<SETS js>" PT(true|false) : region means (toggles.js) and
# stability (stability.js) of ours-rt per set, at the maintainer's carConcept view (W50).
# Run from docs/research/w53. Server: REFLECTIONS_PORT=5441.
TAG=$1; Q=$2; SETS=$3; PT=${4:-false}
U="http://127.0.0.1:5441/showcase/compare.html?manual&left=ours-rt&right=ours-rt&$Q"
VIEW="POS=[0.491,2.302,5.617], TGT=[0,0.25,0]"
perl -e 'alarm 1500; exec @ARGV' node scripts/drive.mjs "$U" shots scripts/toggles.js "const TAG='$TAG', $VIEW, PT=$PT, WARM=90, N=16, SETS=$SETS;" | tail -1
perl -e 'alarm 1500; exec @ARGV' node scripts/drive.mjs "$U" shots scripts/stability.js "const TAG='$TAG', $VIEW, WARM=90, N=32, SETS=$SETS;" | tail -1
