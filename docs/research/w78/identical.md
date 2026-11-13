# W78: default-is-identical (BRDF weights off, no sample direction)

Baseline: reflections main `62f7162` with Denoiser main `7014384` (an export of that commit, `git archive`). Branch: reflections `0108d39` with Denoiser `w78-brdf-prefilter` `6d54fca`. Same worktree and server (5450): reflections sources swapped with `git checkout main -- packages examples src`, `DENOISER_REPO` pointed at the export; the baseline page's `FfxReflectionDenoiser.options` was checked to have no `brdfWeights` (Denoiser main served).

Setup (`scripts/identical.sh`, W74's with the denoised output hashed): `frameIndex` 5, `minTraversalOccupancy` 0, AA off, 12 frames from a fresh load, `?rt=1` (@pmndrs/bvh), denoiser on.

| capture | denoised / radiance / hit distance / confidence / rt source (FNV of the raw texels) | final PNG max diff |
|---|---|---|
| ssr page: offscreen, contact, mirrorWall, facingMirrors, moving | equal, all 5 x 5 | 0/255 |
| showcase carConcept 960x540 | equal | 0/255 |

Verdict: bit for bit at the default, through both repos (Metal only).

**Re-run after merging main `22adc27` and adding `keepHistoryOnBlack` (Denoiser `26c54ba`):** the 5 ssr scenes hash equal to main's capture above on all 5 outputs (0/255). showcase carConcept: tracer outputs equal; the denoised hash varies between runs of the *same* build (three runs: `7cb21206` = main's, `a70b0d39`, `13b78d6a`; 2 px at 1/255), the class W74 saw on carConcept. Verdict unchanged: identical at the default, within carConcept's own run-to-run noise.

**After the review fixes (reflections `a16ef51`, Denoiser split branch `81bbb09`):** all 6 captures equal main's (0/255, carConcept's denoised hash too). With `keepHistoryOnBlack` on by default (`83e694b`): tracer outputs equal; denoised differs on offscreen (2326 px, max 78/255), moving (3237 px, 79/255), contact (24 px), carConcept (12 px, 4/255), mirrorWall and facingMirrors 0 — the reflections that were black some frames, by design (README, "Update after review"). The Denoiser test bed on the split branch: off and keepBlack=1 both 23.4556 dB, flicker 0.00803 (= main).
