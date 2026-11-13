# W74: default-is-identical (tracedMissRate 'full')

Baseline `0abd154` (main) vs branch `0964ceb`, same worktree and server (5446), sources swapped with `git checkout 0abd154 -- packages examples src` (served module checked).

Setup (`scripts/identical.sh`): `frameIndex` 5, `minTraversalOccupancy` 0, AA off, 12 frames from a fresh load, `?rt=1` (@pmndrs/bvh). Occupancy 0 because with FFX's occupancy exit on, two runs of the *same* build differ (contact max 23/255 on the final): which glossy rays share a subgroup follows the classify append order, an atomic race.

| capture | radiance / hit distance / confidence / rt source (FNV of the raw texels) | final PNG max diff |
|---|---|---|
| ssr page, denoiser off: offscreen, contact, mirrorWall, facingMirrors, moving | equal, all 5 x 4 | 0/255 |
| ssr page, denoiser on: same 5 | equal | 0/255 |
| showcase carConcept 960x540 | equal | 1/255 on 1 px (two runs of the branch alone: the same 1 px, 1/255) |

Verdict: bit for bit at the default.
