# W75: default-is-identical (reflectionResolution 'full')

Baseline: main `0abd154` vs this branch at `f35712b` (W74 merged in + the X5 step 1 build), same worktree and server (5447, `DENOISER_REPO=~/Developer/Denoiser-w53-rebase` = denoiser#29 `240f39f`). Main's sources were swapped in with `git checkout 0abd154 -- packages examples src` (served `composite.ts` checked: no `upsampled`), then restored.

Setup (`scripts/identical.sh`, W74's): `frameIndex` 5, `minTraversalOccupancy` 0, AA off, 12 frames from a fresh load, `?rt=1` (@pmndrs/bvh).

| capture | radiance / hit distance / confidence / rt source (FNV of the raw texels) | final PNG max diff |
|---|---|---|
| ssr page, denoiser off: offscreen, contact, mirrorWall, facingMirrors, moving | equal, all 5 x 4 | 0/255, 0 px |
| ssr page, denoiser on: same 5 | equal | 0/255, 0 px |
| showcase carConcept 960x540 | equal | 0/255, 0 px |

Verdict: bit for bit at the default. 'full' builds no new node: `HybridReflections.composite()` adds the `upsampled` branch only when the setting is 'half' at build time, and the tracer path is unchanged (the half frame is only made in 'half').
