# W85: flicker (T1, T53, contact rest drift, T36, T38, T10, T2)

- `pnpm check -- --only flicker` (scripts/flicker.mjs): X0's metrics per scene x config. Env: FLICKER_SCENES (`ssr:contact`, `bench:cubeFloor`, `bench:carConcept@w50/ours-rt`), FLICKER_CONFIGS (JSON: label, q = bench query, ssr = settings object, ssrEval), FLICKER_REPEAT, FLICKER_LABEL. Writes out/flicker-<label>.{json,md}.
- New metric `stageRest` (examples/shared/metrics/run.ts): consecutive-frame change per stage (display, raw signal, denoised).
- T53 scenes (bench): cubeFloor, edgesFloor, plateFloor, with named regions (bench/regions.ts).
- Files: baseline-defaults.*, contact-ab.md, variance-guided.*, quad-matrix.*, hitsource.json.

## Findings
1. The W76 contact "+7-12 %" rest drift is noise: one page's repeats of the same config spread 0.72-0.83; new defaults 0.72-0.80, old (cone off, mirrorBias 0, no compensation) 0.79-0.82, with RT 0.75-0.78 vs 0.76-0.79. Rest flicker 4.50 vs 4.50. No default to revert.
2. Contact's real flicker is the per-frame rest change 4.5/255 (orbit std 9.7), independent of every tracer setting. stageRest: raw signal 0.034, denoised 0.004, display 5.9 (AA off 0.07; probes=0 0.012; composite off 0.002). So it enters in the composite: `final = lit + w (denoised - probeSpecular)`. The composite's own probe lookup (`probeSpecular` view) is torn in horizontal bands against the scene pass's clean lit probe term (`noSSR` view), also with AA off; P reconstruction is exact (floor y within 7e-6). Cause not found (G-buffer has no `specular` target on that page, so the weight is the estimate). Offscreen shows 1.6. carConcept / Sponza / simple scenes are at <= 0.011.
