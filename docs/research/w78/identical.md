# W78: default-is-identical (BRDF weights off, no sample direction)

Baseline: reflections main `62f7162` with Denoiser main `7014384` (an export of that commit, `git archive`). Branch: reflections `0108d39` with Denoiser `w78-brdf-prefilter` `6d54fca`. Same worktree and server (5450): reflections sources swapped with `git checkout main -- packages examples src`, `DENOISER_REPO` pointed at the export; the baseline page's `FfxReflectionDenoiser.options` was checked to have no `brdfWeights` (Denoiser main served).

Setup (`scripts/identical.sh`, W74's with the denoised output hashed): `frameIndex` 5, `minTraversalOccupancy` 0, AA off, 12 frames from a fresh load, `?rt=1` (@pmndrs/bvh), denoiser on.

| capture | denoised / radiance / hit distance / confidence / rt source (FNV of the raw texels) | final PNG max diff |
|---|---|---|
| ssr page: offscreen, contact, mirrorWall, facingMirrors, moving | equal, all 5 x 5 | 0/255 |
| showcase carConcept 960x540 | equal | 0/255 |

Verdict: bit for bit at the default, through both repos (Metal only).
