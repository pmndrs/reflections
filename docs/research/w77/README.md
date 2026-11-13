# W77: keep marching after a rejected hit (`maxCandidates`)

The idea is from three.js PR bhouston/three.js#155 (`SSRTrace.js`, `traceHiZ`'s `maxCandidates`). FFX SSSR marches to the first place the ray goes behind the depth buffer and validates that hit once. If it fails (confidence 0), the ray is a miss and takes the probe, the environment or the RT fallback. Here a rejected hit restarts the march just past that leaf cell and keeps going, up to N candidates.

## Verdict

**Keep it as an opt-in setting, default 1. Not a default change, and no change to T11.**

- It does what it is meant to for a thin foreground object. On the new `thinPost` scene (a 6 cm post and a 4 cm rail in front of a wall, over the mirror floor) the wall class goes from 0.944 to 0.988 confident, and the miss list at 1080p drops 27 % (87.6k to 63.9k). But it needs 8 candidates for a 6 cm post at this distance: nothing changes at 2 and 4. The cost is the leaf cells while the ray is behind the object.
- Everywhere else it is a wash. mirrorWall, lowSphere, facingMirrors and carConcept do not move (tables below).
- It costs about +0.25 ms of intersect at 1080p at 8 on the example scenes (mirrorWall 0.93 to 1.21 ms), for scenes that do not need it.
- It cannot help the cases T11 is for. Those surfaces are hidden from the camera; the restart only finds surfaces the camera sees. mirrorWall's `behind` class stays probe (c 0.047 / 0.048, zero 0.845 / 0.835 at 1 / 8).
- It also makes a few extra confident hits that are not exact. On thinPost the wall points the post hides now get the neighbouring wall texel beside the post (a "streak" by the readback's definition: 0.040 to 0.462 of the 649 hidden px at 8). For a post this thin that is a small colour error; for a wide occluder the budget runs out first.

Worth enabling for a scene with many posts, rails, fences or railings over a mirror floor. Not worth a default.

## What was built

- Core setting `maxCandidates` (integer 1..8, default 1; `ScreenSpaceReflectionsSettings`, three `ssr.settings.maxCandidates` passes through, bench `s.maxCandidates`, `docs/SETTINGS.md`). `Params.maxCandidates` at word 158 (words 141-157 reserved as `_r141..._r157` for W70-W74; PARAMS_SIZE 576 to 640).
- `packages/core/src/sssr/shaders.ts`: `rayConfidence` (finishRay's confidence, shared) and `tryRestart`, used by both loop variants.

```wgsl
fn tryRestart(r: ptr<function, Ray>, candidates: ptr<function, u32>) -> bool {
  if (*candidates >= P.maxCandidates) { return false; }
  let m = &(*r).march;
  if ((*m).i >= P.maxTraversalIntersections || (*m).exit_due_to_low_occupancy || (*m).current_mip >= (*m).most_detailed_mip) { return false; } // budget, occupancy exit, or no hit
  let hit = (*m).position;
  if (hit.x < 0.0 || hit.y < 0.0 || hit.x > 1.0 || hit.y > 1.0) { return false; }                      // off screen
  if (loadDepth(vec2i(screen_size * hit.xy) / 2, 1) == FAR_PLANE) { return false; }                     // background
  if (rayConfidence(r) > 0.0) { return false; }                                                          // accepted (partial confidence too)
  // exit plane of the hit's cell at the most detailed mip, plus uv_offset (AdvanceRay), back at that mip
  ...
  *candidates += 1u;
  return true;
}
```

  - 'subgroups': `loop { while (marchRunning) { ballot; marchStep } if (!tryRestart(&r, &candidates)) { break; } }`.
  - 'workgroup': `running = running && (marchRunning(&r.march) || tryRestart(&r, &candidates));`, so the occupancy count sees a restarted ray as running.
  - The budget `maxTraversalIntersections` is shared: a restart does not reset `i`.
- Test scene `thinPost` (`examples/shared/scenes.ts`, in `TEST_SCENES`: `examples/ssr?scene=thinPost`). The wall readback (`wallPx`, `hitErr`, behind / streak) now also runs on it.
- Bench: `P.traceStats()` (the traced pass's counters per side, via `CompareMethod.traceStats`) for the miss count on carConcept.
- `pnpm check` (sssr-core parity): two more configs at occupancy 0 with `maxCandidates` 4 and 8 (the two variants agree bit for bit).

## Measure

960x540, AA off, denoiser off, `frameIndex` 7, loop stopped, RT off unless noted (`scripts/ssr.js`, `scripts/summ.cjs`, logs in the commit message). The classes are W22's `blendStats()` and `stats()`.

**Default is bit-identical.** `radianceHash(7)` at occupancy 0 (deterministic, D301) with the old and the new shader at `maxCandidates` 1: mirrorWall `d7a2011a` both, facingMirrors `075039ee` both (misses 9204 / 33111 both).

### mirrorWall (default pose)

| maxCandidates | rays | misses | wall class confident | wall corr / mean rel err / hit dist med rel err | hidden px (`behind`) confident c / zero | streakFraction | behindSSR | objectProbe (object class) | cube stripe ratio |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 197902 | 9240 | 0.990 | 0.9985 / 0.0175 / 5.6e-5 | 0.047 / 0.845 | 0.0456 | 0.1126 | 0.0108 | 1.30 |
| 2 | 197902 | 9204 | 0.990 | same | 0.047 / 0.845 | 0.0456 | 0.1126 | 0.0092 | 1.16 |
| 4 | 197902 | 9145 | 0.991 | same | 0.048 / 0.839 | 0.0497 | 0.1175 | 0.0027 | 0.94 |
| 8 | 197902 | 9099 | 0.991 | same | 0.048 / 0.835 | 0.0497 | 0.1180 | 0.0027 | 0.94 |

The `wall` readback row (97187 px whose wall point the camera sees): confident 0.9943 / 0.9943 / 0.9948 / 0.9953, correlation to the analytic wall colour 0.9985 and median hit-distance error 5.6e-5 at every value. The objects' stripe pattern improves a little (the sphere's probe weight 0.0083 to 0.0062, the cube's stripe ratio 1.30 to 0.94), small against the 9000 px of misses. `behind` stays probe; no new streaks beyond 4 of 965 px.

### lowSphere (mirrorWall's low pose; D2402)

| maxCandidates | misses | wall class confident | `behind` (17669 px) confident / zero | behindSSR | sphereProbe | streak |
|---|---|---|---|---|---|---|
| 1 | 50074 | 0.946 | 0.001 / 0.876 | 0.0955 | 0.0036 | 0.0037 |
| 2 | 50025 | 0.946 | 0.001 / 0.875 | 0.0962 | 0.0017 | 0.0038 |
| 4 | 49963 | 0.946 | 0.001 / 0.875 | 0.0962 | 0.0004 | 0.0038 |
| 8 | 49938 | 0.947 | 0.001 / 0.875 | 0.0963 | 0.0004 | 0.0040 |

As expected for D2402: the crescent and the probe ghost are the surface the camera cannot see, so the `behind` class does not move. The sphere's own probe weight falls from 0.0036 to 0.0004 (a few rays that grazed its rim).

### facingMirrors (D4303's fringe)

| maxCandidates | misses | left-mirror panel confident | mean luminance |
|---|---|---|---|
| 1 | 33128 | 0.95905 | 0.24226 |
| 2 / 4 / 8 | 33092 / 33054 / 32973 | 0.95905 | 0.24226 |

Unchanged at every value, and with `?rt=1` too (1.0000, 0.23977). The fringe is rays accepted by the thick test (partial confidence, counted as accepted), not rejected ones, so the restart does not touch it. I did not re-count W44's red px in the sphere's box: the panel's confidence and luminance are identical to the digit, so the count cannot have moved.

### thinPost (the case this targets; 960x540)

| maxCandidates | misses | wall class confident (133327 px) | wall `confidentFraction` (127997 px the camera sees) | hidden-by-post px confident (streak) | mirror floor confidence |
|---|---|---|---|---|---|
| 1 | 14407 | 0.944 | 0.9464 | 0.040 | 0.6330 |
| 2 | 14407 | 0.944 | 0.9464 | 0.040 | 0.6330 |
| 4 | 14405 | 0.944 | 0.9464 | 0.040 | 0.6337 |
| 8 | **8534** | **0.988** | **0.9923** | 0.462 | 0.6639 |

Hit quality on the wall px the camera sees: correlation 0.9973 to 0.9975, mean relative error 0.0178 to 0.0177, hit-distance median error 6.0e-5 to 5.9e-5: the extra hits are as good as the rest. With `?rt=1` all of them are traced either way (1.0000); the RT load is what falls (the miss list 14407 to 8534 at 960x540; 87.6k to 63.9k at 1080p).

`thinpost.jpg` (floor region around the post at 3x; left maxCandidates 1, right 8; top the misses view, bottom the final image, no denoiser): at 1 the rail's reflection is a block of probe px (red), at 8 it is the wall, with thin lines left where the rail's cells are wider than the budget.

### carConcept (bench, 960x540, w50, PT 16 spp, ours + RT)

Cells are luma / MAD vs the PT. Raw = denoiser off. The baseline reproduces W58 (lip 18.6 / 14.0 raw, 41.5 / 30.6 denoised).

| maxCandidates | lip raw | band raw | lip denoised | band denoised | frame raw | frame denoised | wheel raw | car raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 73.3 / 18.7 | 18.9 / 14.0 | 93.0 / 41.5 | 35.5 / 30.6 | 149.5 / 7.2 | 150.4 / 7.9 | 38.7 / 27.8 | 104.6 / 13.7 |
| 2 | 73.4 / 18.5 | 19.0 / 14.1 | 93.0 / 41.7 | 35.4 / 30.6 | 149.6 / 7.2 | 150.4 / 7.9 | 38.3 / 27.7 | 104.6 / 13.7 |
| 4 | 73.4 / 18.5 | 18.9 / 14.0 | 93.2 / 41.8 | 35.4 / 30.5 | 149.5 / 7.2 | 150.4 / 7.9 | 38.5 / 27.7 | 104.5 / 13.7 |
| 8 | 73.3 / 18.3 | 19.0 / 14.1 | 93.1 / 41.7 | 35.7 / 30.8 | 149.6 / 7.2 | 150.4 / 7.9 | 38.6 / 27.8 | 104.6 / 13.7 |

Nothing moves (the PT's lip 74.0, band 5.1). Misses at 1080p: 450009 / 449364 / 449077 / 448392 (-0.4 %). carConcept's lip and band errors are not thin-occluder misses; the hits come from the quad copy (W58) and the traced underside.

### Cost (1080p, loop stopped, median of 30 frames, 5 rounds with the values alternating; `scripts/time-ssr.js`, `scripts/timing.js`)

| scene | maxCandidates | intersect ms | core total ms | misses |
|---|---|---|---|---|
| mirrorWall | 1 / 2 / 4 / 8 | 0.928 / 1.056 / 1.156 / 1.207 | 1.214 / 1.363 / 1.485 / 1.544 | 66082 / 67149 / 66364 / 65056 |
| thinPost | 1 / 2 / 4 / 8 | 0.963 / 1.071 / 1.173 / 1.250 | 1.263 / 1.379 / 1.494 / 1.588 | 87595 / 88865 / 87899 / 63905 |
| carConcept (bench, ours + RT) | 1 / 2 / 4 / 8 | 0.779 / 0.734 / 0.870 / 0.756 | (noisy: classify moved 0.18 to 0.67 with the other worktrees' load) | 450009 / 449364 / 449077 / 448392 |

The example scenes' classify also rises 0.147 to 0.170 ms over the run (drift: the values are measured in one order inside each round), so about 0.02 ms of each step is drift; the intersect cost at 8 is about +0.25 ms (+27 %). carConcept shows no trend (every ray there ends in a hit, a miss or the budget before a rejected candidate is common). The miss counts in the cost table come from different frames and wobble by a percent, so only thinPost at 8 is a real change.

## Checks

- `pnpm typecheck` and `pnpm test` (64) pass. `docs/SETTINGS.md` regenerated (`UPDATE_SETTINGS_DOC=1`).
- sssr-core parity at occupancy 0, `maxCandidates` 1 / 4 / 8 on its scene: the two variants agree on every list and 0 px of radiance and hit differ (misses 4210 / 3380 / 3320, so the restart does run there).
- `REFLECTIONS_PORT=5449 pnpm check`: see HANDOFF.

## Not done

- The workgroup variant was parity-checked but not timed separately.
- A budget above 8 (a wider post needs more candidates); the PR's own default is 1 as well.
- Skipping the thickness reject for partial occluders by rejecting on the far side of the cell (a cheaper rule than restarting per leaf cell).
- Restarting at a coarser mip when the next cells are known to be behind the same object (it would pass wide objects in fewer steps).
