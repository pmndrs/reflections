# W87: composite probe-lookup flicker (contact / offscreen)

## Root cause
`screenSpaceComposite` rebuilds the world position P from the depth buffer and looks the probes up there (`probeSpecular`, `coverage`). Three's lit pass uses the exact fragment position. On `examples/ssr?scene=contact` the floor probe's influence box starts at the floor (y = 0). The rebuilt P.y is 0 +- ~7e-6 (sign changes per pixel and per jitter), so the composite's lookup flipped between the volume (the box-projected wall) and the environment slot. The subtraction `lit + w (denoised - probeSpecular)` then removed a different term than the lit pass added: horizontal stripes in `probeSpecular` (rows of constant P.y sign), and a residual that changes with every jitter phase.

Found by: a temporary view `w x probeSpecular` next to `noSSR` (metal floor, so lit = w x probe): mean 8-bit abs difference 18.8 on the lower floor with AA off (a static mismatch, so not the jitter itself). Debug views of R and N were smooth and P looked smooth, but its y sits on the volume face.

## Ruled out
- Depth precision (depth32float, the floor's depth is smooth per row), reflection vector R, normal (rgba16float, smooth), roughness (three's 0.045 clamp matches; a flat floor has no geometry roughness), the weight estimate (a smooth scale, not stripes), jitter in P (uniforms carry the jittered projection; P exact to 7e-6).

## Fix
`packages/three/src/sssr/composite.ts`: lookups at `P + N x (2e-5 x |viewPosition| + 1e-5)` (D5420). P moves off the surface by more than its reconstruction error; the box-projection origin moves by ~1e-4 m. No math in the adapter, no extra G-buffer target. After: `w x probeSpecular` equals the lit image to 0.02 (8-bit) on the floor rows that show the wall.

## Flicker (`pnpm check -- --only flicker`, FLICKER_REPEAT 2, loaded machine, reflection region; two numbers = the two repeats)
| scene | drift before | drift after | rest before | rest after | orbit std before | orbit std after |
|---|---|---|---|---|---|---|
| ssr:contact | 0.8176 / 0.7926 | 0.3906 / 0.3994 | 4.508 | 0.0067 | 9.6597 / 9.4377 | 0.468 / 0.4658 |
| ssr:offscreen | 0.2671 / 0.2853 | 0.1931 / 0.1941 | 1.5969 | 0.0036 | 2.8741 / 2.8652 | 0.1823 / 0.1858 |
| ssr:mirrorWall | 0.3079 / 0.3092 | 0.3052 / 0.3064 | 0.0093 | 0.0094 | 0.4673 / 0.4697 | 0.4635 / 0.4652 |
| bench:carConcept@w50 | 0.2676 / 0.2672 | 0.268 / 0.2708 | 0.0073 | 0.0073 | 0.3916 / 0.3937 | 0.3914 / 0.3927 |
| bench:sponza@hero | 0.3015 / 0.3154 | 0.3075 / 0.3155 | 0.0113 | 0.0113 | 0.5544 / 0.5541 | 0.5543 / 0.5544 |
| bench:cubeFloor | 0.0359 / 0.0355 | 0.0358 / 0.0353 | 0.0011 | 0.0012 | 0.0719 / 0.0718 | 0.0718 / 0.0717 |
| bench:edgesFloor | 0.1992 / 0.1983 | 0.1985 / 0.1986 | 0.0031 | 0.0032 | 0.2077 / 0.2079 | 0.207 / 0.2075 |
| bench:plateFloor | 0.0108 / 0.0105 | 0.0111 / 0.0108 | 0.0004 | 0.0004 | 0.0562 / 0.0565 | 0.056 / 0.0563 |

Colour change at rest (AA off, final view, 960x540): contact mean abs 4.97 over the image / 9.91 over the lower half (the torn floor, now clean: wall text and object reflections no longer cut by stripes), offscreen 0.34 / 0.46. The "before" is the artefact, not a colour to keep.

## Babylon / pixi (read only)
Their composites do no probe math (`packages/babylon/src/composite.ts`); they take core's `radiance`, which lerps the hit with `sampleRadianceFallback(world_space_origin, ...)`, and `world_space_origin` is rebuilt from depth too. There is no subtraction, so no residual flicker from a mismatch, but a surface on a volume face can flip between volume and environment in that fallback the same way. Not fixed.
