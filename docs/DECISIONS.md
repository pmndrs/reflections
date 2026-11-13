# Decisions

Every call the maintainer made on the Reflections Decisions page (https://claude.ai/artifact/E8qHQUAKxkGbW6wQ2F2sCX), newest first. The page is where open questions go; this file is its record in the repo. Regenerate it from an export of the page's db with `node scripts/decisions-doc.mjs <exportDir>`. The ranked to-do list that follows from these calls is [TRIAGE.md](TRIAGE.md).

| # | Decision | Status | Answer | Source |
|---|---|---|---|---|
| 21 | [Make `quadCopy: 'sameSurface'` the default?](#quad-copy-default) | closed | Default after a check on the other scenes | W58 (D3740) |
| 20 | [Build occlusion for traced hits' specular (hub, floor under the car)](#hit-lobe-occlusion) | closed | Build lobe occlusion (option, off by default) | W54/W56 (D3681) |
| 19 | [three's geometry roughness on our pages](#geometry-roughness) | closed | Examples off when AA is on | W56 (D3720) |
| 18 | [Make wheel-well probes carConcept's default?](#car-wheel-probes-default) | closed | Default, and fix box rotation | W55 (D3700–D3702) |
| 17 | [Car: closed spaces (wheels, cabin) lit as if open](#car-occlusion) | closed | Try probes inside the car first | W54 (D3680, D3681) |
| 16 | [Triage page Q1 / Q2: mixed probe sizes and the texture limit](#triage-q1q2) | closed | - | triage page Q1/Q2 · W62 · W63 |
| 15 | [Should basic / Lambert / Phong materials be able to opt into reflections?](#basic-materials) | closed | Document only | D2802 · W27 |
| 14 | [What should the next build batch be?](#next-batch) | closed | docs-first | reflections-60 handoff · DIVERGES triage (v17) |
| 13 | [How do you want to try the denoiser's hit-source option on the bench?](#denoiser-29) | closed | Run the bench against the branch | W53 · D3660–D3663 · denoiser#29 |
| 13 | [Neighbour ray reuse (ratio estimator): here, in the denoiser repo, or not yet?](#ratio-estimator) | closed | other | SSR source review 2026-11-12 · D50 · D3550 |
| 12 | [Showcase Sponza: switch to the slab-and-grid probe volumes at 128 px?](#sponza-volumes) | closed | Switch after a visual check | W62 · W61 · D4900 |
| 11 | [The wheel's reflection lost its key-light highlights. Should the re-shade use a visibility ray?](#wheel-reshade) | closed | Add the visibility ray as a setting, try it on the car | W50 · D3542 |
| 10 | [Halo under the car door: how do we fix it?](#car-halo) | closed | - | W50 · D3610 |
| 9 | [Make @pmndrs/bvh the default ray-tracing provider in the examples?](#bvh-default) | closed | Yes, flip the examples now | W48 · D1705 |
| 8 | [When should @pmndrs/bvh go to npm?](#bvh-release) | closed | Release bvh sooner | SPEC follow-ups |
| 7 | [Specular occlusion still darkens near-mirror edges when RT is off. Fix now or later?](#so-rt-off) | closed | Backlog it | D4513 · W45 |
| 6 | [Without RT, reflected wheels and the underside read too light. Fix now or later?](#reshade-occlusion-ssr) | closed | Backlog it | W44 backlog |
| 5 | [With RT on, re-shaded on-screen hits skip the blocked-ray check. Keep it that way?](#reshade-visibility-rt) | closed | Keep it skipped | W44 · D3542 |
| 4 | [Sponza with RT reads 1.3 worse against the path tracer with specAA on. Accept for now?](#sponza-rt-specaa) | closed | Accept, re-measure later | W46 |
| 3 | [Keep roughness-from-normal-variance on by default in the examples?](#specaa-default) | closed | Keep it on | W46 · D3570 |
| 2 | [How much blur at reflection hits (hitLobeFilter)?](#lobe-filter) | closed | Keep 1 (default) | W45 · D3550 |
| 1 | [File the three.js issue about stock materials and node properties?](#three-issue) | closed | File it as drafted | D3572 |

## Make `quadCopy: 'sameSurface'` the default?

<a id="quad-copy-default"></a>
**Status:** closed (answered 2026-11-13) · **Source:** W58 (D3740) · **Recommended:** Default after a check on the other scenes · **Answer:** Default after a check on the other scenes

FFX traces one ray per 2x2 block of pixels and copies its result to the whole block. At silhouettes that hands one surface's reflection to another, which causes the stair-stepped edge you found under the car (the halo's seed, before the denoiser spreads it). `sameSurface` lets a block pixel trace its own ray when its depth (>5%) or normal (>~25°) differs from the traced pixel's. carConcept at 960x540, lip/band error against the path tracer: raw 18.6/14.0 → 11.5/12.2, denoised 41.5/30.6 → 34.4/26.9. At 1080p the denoised lip goes 24.6 → 20.1. That is as good as four rays per block, for a fraction of the cost: +0.27 ms at 1080p. Not yet measured on chess, toyCar or Sponza. One edge still steps: the band's lower boundary is one surface, so its reflected silhouette is still sampled per block. Try it on the bench: Screen-space → quadCopy.

Options:
- **Default after a check on the other scenes** (chosen): Run the same measure on chess, toyCar and Sponza (for regressions or noise at many silhouettes). If they're flat or better, make it the default; tune the thresholds later.
- **Default now**: Flip it now and tune later.
- **Keep it as an option**: FFX's behaviour stays the default.

Maintainer's note: (chat) “the sponza demo seems fine and I think your reccomendations are fine for now.”

Outcome: Accepted: measure `sameSurface` on chess, toyCar and Sponza (and the new simple edge scenes), then make it the default if they're flat or better. Queued on the triage table.

## Build occlusion for traced hits' specular (hub, floor under the car)

<a id="hit-lobe-occlusion"></a>
**Status:** closed (answered 2026-11-13) · **Source:** W54/W56 (D3681) · **Recommended:** Build lobe occlusion (option, off by default) · **Answer:** Build lobe occlusion (option, off by default)

Your observation that the ground is lit under the car is confirmed for ours: the floor directly beneath the car reads 24 vs the path tracer's 8 (base three alone: 167). The cause is the same as the bright hub. A ray from the floor hits the car's underside, and that hit's own reflection is looked up in the probe as if nothing blocked it. With traced-hit specular off, the floor drops to 4.6. That setting can't be the fix, though, because it worsens the whole frame (10.5 → 13.6). W52's single visibility ray only helps a little, because one ray along the mirror direction misses most of a rough hit's lobe. The wheel probes fix the wheel half, not the underside.

Options:
- **Build lobe occlusion (option, off by default)** (chosen): Test a few short rays or a cone over the hit's lobe, using the BVH, and darken by the blocked share. Measure on the floor-under-car, hub and lip regions, and the cost per traced hit. Package work in core and three.
- **Try a probe under the car first**: Example-side, like the wheel probes: a flat box under the car, captured from below. Cheap. It may fight the floor mirror's own lookup.
- **Later**: Track it and keep it in the backlog.

Maintainer's note: (chat) “I think your recommendations are fine for now. … we are chasing refinement now a bit too hard and can circle back or make other tests with things like cubes directly against the mirror or sharp edges above it.”

Outcome: Accepted as the direction, but parked: lobe occlusion for traced hits is on the triage table. It comes after the simple test scenes (cubes on the mirror, sharp edges above it), so it isn't tuned on the car's bevels.

## three's geometry roughness on our pages

<a id="geometry-roughness"></a>
**Status:** closed (answered 2026-11-13) · **Source:** W56 (D3720) · **Recommended:** Examples off when AA is on · **Answer:** Examples off when AA is on

three r187 adds roughness from how fast the normal turns on screen, to stop small curved parts sparkling. The path tracer has no such term. On carConcept's chrome star it is about 40% of the excess (100 → 79, PT 50). Turning it off barely moves anything else: frame error 10.5 → 10.4, lip 55.6 → 56.5. Paint flicker in a slow orbit rises 1.3% with the upscaler on and 8.1% with AA off; the floor is flat, so it is unaffected. Try it on the bench: Materials → geometryRoughness. This only sets what our examples do; it isn't library behaviour.

Options:
- **Examples at 0.25**: Keep a quarter of the term: most of the star gain (100 → 82), with little sparkle risk.
- **Examples off when AA is on** (chosen): Matches the path tracer. The upscaler absorbs the extra sparkle (+1.3%). AA off keeps three's term.
- **Keep three's term**: No change; the bench option stays for comparisons.

Maintainer's note: (chat) “I think your recommendations are fine for now.”

Outcome: Accepted: the examples drop three's geometry roughness when the upscaler/AA is on. Queued on the triage table (small).

## Make wheel-well probes carConcept's default?

<a id="car-wheel-probes-default"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W55 (D3700–D3702) · **Recommended:** Default, and fix box rotation · **Answer:** Default, and fix box rotation

Bench: `carProbes=wheels&carProbeRes=64` on carConcept. Against the path tracer: hub 44 → 27 (PT 28), floor-reflected wheel 47.5 → 32.7 (PT 32.1), W50 wheel 44 → 24.6 (PT 24.6). Halo regions unchanged. Cost: +1.3 MB, +0.8 ms at 1080p, +14 ms bake, and ~440 ms of CPU once at load to place the boxes. Known flaw: a faint step on the front tyre's outer ~9 cm, because probe boxes can't rotate and the car is turned (D3701). The wheel face lands 6 under the path tracer (30 vs 36). Try it: http://127.0.0.1:5420/showcase/bench.html?scene=carConcept&pose=w50&size=1280x1280&left=ours-rt&right=pathtraced&carProbes=wheels&carProbeRes=64 (5420 serves the main checkout, so a page reload picks it up).

Options:
- **Default to wheels at 64**: carConcept's showcase and bench start with the wheel probes on. Example-only, no package change. The cabin probe stays an experiment value.
- **Default, and fix box rotation** (chosen): As above, and also give probe influence boxes a rotation (D3701), so the tyre edge step goes away and boxes fit turned objects. Package work in core and three: the lookup and the W63 grid both need oriented boxes.
- **Keep it as a bench option**: Leave the default off. Use it as a reference for how to place probes in docs.

Outcome: Accepted (2026-11-13): wheel probes at 64 as carConcept's default, plus rotated probe boxes. Queued on the triage table, not built yet.

## Car: closed spaces (wheels, cabin) lit as if open

<a id="car-occlusion"></a>
**Status:** closed (answered 2026-11-13) · **Source:** W54 (D3680, D3681) · **Recommended:** Try probes inside the car first · **Answer:** Try probes inside the car first

The car's wheel interiors and cabin are too bright because nothing in the render knows they are enclosed. That is mostly three's own environment lighting (wheel interior: 45 with none of our passes, vs the path tracer's 18), plus ours on the chrome hub, where rays from inside the wheel are lit the same way (44 vs 28). Our existing GTAO specular occlusion helps a little (45 → 39). One reflection probe sits outside the car and captures the open studio, and three's lighting reads that probe, so the wheels and cabin get open-studio light.

Options:
- **Try probes inside the car first** (chosen): A bench setting (off by default): a small probe in each wheel well and one in the cabin. They would capture the dark interiors, so both three's lighting and our hit shading read occluded light there. Example setup only, no package change. Cheap, and it tests the cause directly. Measured on the bench, then you decide.
- **Build lobe occlusion for hits**: Package work: hits whose reflection lobe is wide would test several rays or a cone instead of one, so the hub's hits inside the wheel go dark. Fixes the hub and the floor-reflected wheel only, not three's own lighting of the interiors. More cost per traced hit.
- **Accept and document**: Record it as three's lighting limit (no occlusion of environment light) and point to GTAO and probe placement in the docs. The hub stays bright.

Maintainer's note: (from chat) Small probes in the wheels and interior would be interesting, and they let us try multi-size probes in a smaller scene. Try it.

Outcome: W55 built it (bench `carProbes`, merged bacf563). The wheel probes fix the hub, the reflected wheel and the wheel interiors to within a few points of the path tracer. The cabin probe doesn't help. Whether wheels@64 becomes carConcept's default is the next decision on this page.

## Triage page Q1 / Q2: mixed probe sizes and the texture limit

<a id="triage-q1q2"></a>
**Status:** closed · **Source:** triage page Q1/Q2 · W62 · W63 · **Recommended:** - · **Answer:** -

The two questions on the old Divergence Triage page. You remembered answering Q2; it has been built since.

Outcome: Both are done. W62: Sponza's 18 sampled textures came from three's composite binding every probe atlas twice. It's now 13/14/15 at 1/2/3 sizes, and four sizes fit WebGPU's default 16. The support check is in place: the library asks for more only when the adapter has more (min(adapter, 32)), and core passes count their bindings at build, throwing a clear error that says what to change instead of failing silently. W63: probe lookup cost with many volumes is 9.6 → 0.85 ms at 1080p for 32 volumes. Not covered yet: a three material that binds more than the device allows still fails at three's pipeline creation, with no message of ours. A bake-time warning is in the backlog.

## Should basic / Lambert / Phong materials be able to opt into reflections?

<a id="basic-materials"></a>
**Status:** closed (answered 2026-11-12) · **Source:** D2802 · W27 · **Recommended:** Per-material opt-in · **Answer:** Document only

This is by design, from W27 (D2802). Our composite swaps three's own specular environment term for ours. MeshBasicMaterial, Lambert and Phong have no physically based specular term, so three's PBR environment light never reaches them, and we add nothing either; otherwise a material that says “not shiny” would turn shiny. (A basic material's classic envMap + reflectivity still works as three draws it, but SSR and RT don't feed it.) Before W27 the composite subtracted a reflection three never rendered for these materials, which was wrong.

Options:
- **Per-material opt-in**: For example `material.userData.reflections = { roughness, f0 | metalness, intensity }`: the G-buffer writes those values and the composite adds ours on top for that material. Phong could map shininess to roughness and specular to F0 by default once opted in. Small, examples plus the three adapter.
- **Document only** (chosen): A section in SETTINGS.md / the README: use MeshStandardMaterial (or a NodeMaterial) for reflective surfaces.
- **Later**: Wait until someone asks.

Outcome: Documented in the README under “Which materials get reflections” (3a17d62): standard and physical materials get reflections; basic, Lambert and Phong don't, by design, and the note says why and what to use instead. DIVERGES D2802 keeps the userData opt-in as its revisit condition.

## What should the next build batch be?

<a id="next-batch"></a>
**Status:** closed (answered 2026-11-12) · **Source:** reflections-60 handoff · DIVERGES triage (v17) · **Recommended:** Car / underside quality · **Answer:** docs-first

reflections-60 is folded into this session, so its tracked fixes and the DIVERGES triage page's “do next” list (artifact Li7XEAEvhxy9RshxSEy6sQ, now stale) are here. Nothing is running. Pick one batch; your note can add or drop items. W63's perf follow-ups (skip the probe-table re-upload, one volume walk instead of two, re-time the unroll threshold, the probes flake) stay in the fine-tune backlog for now. Sponza's layout still waits on your look (decision above).

Options:
- **Car / underside quality**: A back-face depth layer, so rays passing behind an object stop taking the probe. This fixes the bright strip under the car with RT off (D2402) and the sphere fringe (D4303). Also: tune re-shade occlusion's march (W52's default candidate), and fix W53's 2×2 stair step at source edges (D3663). Everything lands on the bench as options.
- **Hit fidelity**: D902: textures at traced hits, not one colour per mesh. D3512: clear coat at hits. D2800: the hit weight respects AO and env intensity. D3544: mirror-in-mirror shows its own reflection under the re-shade.
- **Cheaper RT**: A roughness gate and reduced-resolution tracing (half res plus upsample), with each step's cost and its error against the path tracer on the bench.
- **Ground truth + motion**: Path-traced references for the ssr example kits (so every scene can be measured, not only the showcase), and reflection motion vectors for the upscaler/denoiser (the mirror floor's reflected text smears under TAA, W36).

Maintainer's note: (from chat) First make sure our history and docs are tracked in the repo, then consolidate the artifacts from the two sessions (a third research session has experiments too). Before new build work, settle the denoiser situation and the two flows: review Sponza and the car demo.

Outcome: Order: (1) you review the two bench URLs; (2) I export the decisions page and the triage page into the repo (docs/DECISIONS.md) and retire the triage page; (3) the research session's experiments get folded in once you point it at us. The build batches above wait until then.

## How do you want to try the denoiser's hit-source option on the bench?

<a id="denoiser-29"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W53 · D3660–D3663 · denoiser#29 · **Recommended:** Run the bench against the branch · **Answer:** Run the bench against the branch

W53's option lives in draft PR pmndrs/denoiser#29 (branch w53-hit-source, worktree ~/Developer/Denoiser-w53). Reflections main is pushed and works without it (the controls are no-ops). Your 5370 server uses the Denoiser main checkout, so the bench's “Keep hit sources apart” control does nothing there yet. Off by default either way. PR #27 is also still open in that repo.

Options:
- **Run the bench against the branch** (chosen): Start examples with `DENOISER_REPO=~/Developer/Denoiser-w53 pnpm examples`. Nothing gets merged until you've judged it by eye.
- **Review and merge #29**: You review the PR in the Denoiser repo. Off by default there too, so the output only changes when you turn the option on.
- **Not worth it**: Close #29 and remove the reflections-side wiring, since the halo is mostly gone at 1080p.

Maintainer's note: (from chat) Use the branch you need for now, until the denoiser agent reviews the PR stack.

Outcome: The review server on :5420 runs with DENOISER_REPO=~/Developer/Denoiser-w53, which is origin/main plus #29's 2 commits. Your local Denoiser main has 9 unpushed commits, but none touch packages/, so the branch is a superset for what reflections uses. The other open PRs (#24 motion scale, #25 variance, #26 tile list, #27 package pages, #15 jitter study) are in neither, and nothing here depends on them yet.

## Neighbour ray reuse (ratio estimator): here, in the denoiser repo, or not yet?

<a id="ratio-estimator"></a>
**Status:** closed (answered 2026-11-12) · **Source:** SSR source review 2026-11-12 · D50 · D3550 · **Recommended:** Backlog it until the phases are done · **Answer:** other

DiligentFX and Frostbite's Stochastic SSR both reuse neighbouring pixels' rays, weighting each by this pixel's BRDF over the ray's pdf. Frostbite measured 1 ray + 4 reused ≈ the noise of 4 traced rays, and it keeps each pixel's own normal and roughness, where our FFX quad copy pastes one colour across the 2×2. It is also the likely cure for D3550's 26-46 % glossy energy loss: FFX's prefilter weights neighbours by luminance and clips rare bright samples. The catch is placement: it is a spatial filter, and D50 / rule 9 put denoising in the denoiser repo. It needs our sampler's direction and pdf per pixel, which the seam doesn't carry today. Cost L either way. Details: docs/research/ssr-external-sources.md #7.

Options:
- **Backlog it until the phases are done**: Rule 7. Meanwhile tell the denoiser repo that its luminance weight is the likely energy-loss mechanism.
- **Denoiser repo owns it**: Extend the seam with per-pixel direction + pdf; the denoiser's prefilter takes BRDF/pdf weights. Keeps rule 9.
- **A pre-seam estimator pass in core**: Core resolves the quad / neighbours with BRDF/pdf before handing the signal to the denoiser. Needs a DIVERGES row against D50.

Maintainer's note: Maintainer in chat: build it here in its own worktree as an experiment; the denoiser rule is about scale. Move it to the denoiser repo later only if it helps other reflection setups.

Outcome: Planned as stream X3 in docs/plans/ssr-sources-experiments.md. It's a small resolve that replaces FFX's quad copy, as a setting `rayReuse: 'copy' | 'ratio'`, default copy. A later phase B on a denoiser branch would try BRDF/pdf weights in the prefilter. Promotion criteria are in the plan. Not started; waiting for the running flows to wrap up.

## Showcase Sponza: switch to the slab-and-grid probe volumes at 128 px?

<a id="sponza-volumes"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W62 · W61 · D4900 · **Recommended:** Switch after a visual check · **Answer:** Switch after a visual check

W62 compared layouts against the path tracer (PSNR in dB, courtyard / low view; higher is better). Shipped: 16.58 / 15.12 at 33.5 MB. Three sizes: 20.47 / 18.26 at 34.6 MB. Two sizes (512 floor + 256): 20.47 / 18.27 at 62.9 MB. One size at 128: 20.51 / 18.29 at 12.6 MB. On Sponza the probe size barely matters; the volume placement is where the gain is. The catch is cost: the better layout uses 11 volumes instead of 7, which adds about 1.5 ms of lookup at 1080p. W63 is working on that cost now. The texture limit no longer blocks any of these layouts: W62 found the composite was binding every probe atlas twice.

Options:
- **Switch after a visual check** (chosen): You look at `?probeLayout=` on the showcase first. If it reads better, ship 11 volumes at 128 px (about 3.5 dB better, a third of the memory). W63 may take back the 1.5 ms.
- **Switch now**: Trust the numbers and ship it.
- **Wait for W63's lookup fix**: Decide once the cost of more volumes is known.
- **Keep the shipped layout**: 7 volumes, mixed sizes, unchanged.

Maintainer's note: (chat 2026-11-13) “the sponza demo seems fine and I think your reccomendations are fine for now.”

Outcome: Read as: switch Sponza to oneSize128 (11 volumes at 128 px: +3.5 dB vs the PT at a third of the memory, and W63 removed the extra lookup cost). Queued on the triage table as a small task. If “fine” meant keep the shipped layout, say so and it comes off.

## The wheel's reflection lost its key-light highlights. Should the re-shade use a visibility ray?

<a id="wheel-reshade"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W50 · D3542 · **Recommended:** Add the visibility ray as a setting, try it on the car · **Answer:** Add the visibility ray as a setting, try it on the car

On a matched page, re-shading (W44) costs the reflected wheel some contrast: 23.5 → 21.0 (path tracer 26.9), and it reads greyer (43 vs PT 26). The old hit colour, last frame's image, carried the rims' key-light highlights. The re-shade uses image-based light only, and on-screen ray-traced hits are re-shaded without a visibility ray (D3542), so occluded parts brighten. Most of the softness you saw is the compare page's 960×540 canvas. `?w=1920&h=1080` renders it larger.

Options:
- **Add the visibility ray as a setting, try it on the car** (chosen): This is already planned as a setting for mirror-in-mirror. Measure the car with it on, plus its GPU cost, then choose a default.
- **Leave it**: Accept the small contrast loss; the re-shade fixed the door and floor, which matter more.
- **Keep last frame's colour for on-screen ray-traced hits**: Re-shade only screen-space hits. This keeps the highlights, but brings back the view-dependence W44 fixed on those hits.

Outcome: W52 is building the visibility ray for on-screen re-shaded hits as a setting (off by default). It measures the wheel, the halo, mirror-in-mirror, and the GPU cost.

## Halo under the car door: how do we fix it?

<a id="car-halo"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W50 · D3610 · **Recommended:** Fix in the denoiser · **Answer:** -

W50 confirmed a regression. With RT on, the skirt's lower lip went from 36.9 (11-11) to 80.0, against the path tracer's 48.1. Re-shade (W44) adds +18 and the lobe filter (W45) +24. specAA barely matters. Before the denoiser, the lip is right (47). The re-shade correctly brightens the screen-space hits on the floor beside the car (40 → 108, path tracer 92). The FFX denoiser then spreads them over the dark ray-traced hits on the underside (16 → 72). Turning off `?lobeFilter=0` gets the lip to 53. `?reshade=off` gets it to 41, but the reflected door goes back to too dark (63 vs 118). Crops: docs/research/w50/door-skirt-halo.jpg.

Options:
- **Fix in the denoiser**: The FFX denoiser stops blending ray-traced hits with screen-space hits, using hit distance or a source tag in its weights. That fixes the root cause, and the lobe filter's purpose (denoiser#28) can be revisited there. Denoiser repo; an issue plus a PR.
- **Weaken the lobe filter where hits mix**: Scale `hitLobeFilter` down for pixels whose neighbours mix ray-traced and screen-space hits. Done in this repo and faster to ship, but it treats the symptom.
- **Default lobeFilter to 0 for now**: Brings the halo most of the way back (53 vs 48) right away. The dark car paint loses some energy again (W45's reason for 1). Kept as an option on a showcase slider either way.
- **Bring re-shade occlusion forward**: The item you backlogged today. It darkens re-shaded hits under the car, but it's a bigger build.

Maintainer's note: I think all of these need testing directly. I mentioned in chat that I think we need to build a comprehensive test bench. If we do, I can try each of these as options/configs and we can flip on/off on things and compare. These are all guesses to fixes until we can do that, and I want to verify with my eye because yesterdays skirt had a glow too but you're not picking it up

Outcome: Every candidate is being built as an option for the bench, none as a default. W52 (core): the lobe filter weakened where hits mix, and re-shade occlusion. W53 (Denoiser repo, draft PR): the denoiser keeps ray-traced and screen-space hits apart. lobeFilter 0 is already a knob. The bench's region measure covers the door's underside too, to catch the glow you saw yesterday that W50's lip region missed.

## Make @pmndrs/bvh the default ray-tracing provider in the examples?

<a id="bvh-default"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W48 · D1705 · **Recommended:** Yes, flip the examples now · **Answer:** Yes, flip the examples now

We're on bvh main (pushed). Hit accuracy is identical to the old branch; on Sponza bvh finds the true nearest hit for 1024 of 1024 rays, three-mesh-bvh for 1000. Clean re-time (median of 4 alternating runs, 1080p): bvh takes 0.54–0.87× three-mesh-bvh's trace time on every scene (Sponza 0.77 vs 1.42 ms; 1.04 vs 1.87 ms all pixels traced). The published package keeps three-mesh-bvh until bvh is on npm, which you said is soon.

Options:
- **Yes, flip the examples now** (chosen): More accurate and faster on every scene measured. `?bvh=three-mesh-bvh` keeps the old one for comparison.
- **Wait for bvh on npm**: Flip the examples and the package default together.
- **Keep three-mesh-bvh for now**: @pmndrs/bvh stays opt-in (`?bvh=pmndrs`).

Outcome: W51 is flipping the examples (showcase, compare, ssr, bench) to @pmndrs/bvh, with `?bvh=three-mesh-bvh` kept for comparison. The package default changes once bvh is on npm.

## When should @pmndrs/bvh go to npm?

<a id="bvh-release"></a>
**Status:** closed (answered 2026-11-12) · **Source:** SPEC follow-ups · **Recommended:** Release with reflections 0.1 · **Answer:** Release bvh sooner

Our 0.1 can't publish while we link @pmndrs/bvh locally. The bvh session says you have no release plan yet. Nothing is blocked today; this only gates our own publish.

Options:
- **Release with reflections 0.1**: Both go out once reflections is stable; until then we stay on a local link.
- **Release bvh sooner** (chosen): bvh ships 0.1 on its own schedule, and we switch to the npm version.

Maintainer's note: I have two core libs with the downsampler and bvh that many others depend on. Once those are solid 0.1 candidates Ill push them up first, likely very soon.

Outcome: Recorded in SPEC's follow-ups: bvh and the downsampler publish first; we switch our links to npm when they land.

## Specular occlusion still darkens near-mirror edges when RT is off. Fix now or later?

<a id="so-rt-off"></a>
**Status:** closed (answered 2026-11-12) · **Source:** D4513 · W45 · **Recommended:** Backlog it · **Answer:** Backlog it

W45 fixed it with RT on: traced misses skip the term, and the worst case went 12.96 → 3.96. With RT off, near-mirror surfaces beside lit objects still get dark rims (contact scene 23.8 → 33.4 vs a traced reference). It only shows with `?specOcc=1`, which is opt-in.

Options:
- **Backlog it** (chosen): Specular occlusion is opt-in, and RT users are fixed.
- **Fix now**: Weight the term by the hit's confidence or distance for untraced misses.

Outcome: Stays in the backlog (the RT-off half of D4513).

## Without RT, reflected wheels and the underside read too light. Fix now or later?

<a id="reshade-occlusion-ssr"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W44 backlog · **Recommended:** Backlog it · **Answer:** Backlog it

The re-shade has no occlusion: with SSR only, a hit whose bounced ray would be blocked (wheels, rims, the underside seen in the floor) gets the probe's bright light instead of dark. RT users don't see it.

Options:
- **Backlog it** (chosen): It's a quality polish; RT already answers it.
- **Fix now**: Darken by screen-space visibility or the probe's occlusion. Needs design and measurement.

Outcome: In the HANDOFF backlog.

## With RT on, re-shaded on-screen hits skip the blocked-ray check. Keep it that way?

<a id="reshade-visibility-rt"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W44 · D3542 · **Recommended:** Keep it skipped · **Answer:** Keep it skipped

W44's re-shade recomputes a hit's reflection along the bounced ray. Adding W41's visibility ray to on-screen hits made facing mirrors go black in stripes (a mirror blocks the other, with no second bounce), failed the facingMirrors miss-fill check (21.4 → 33.7), and darkened the car skirt to 12 instead of 35 (path tracer 69). Off-screen traced hits keep the check.

Options:
- **Keep it skipped** (chosen): Revisit if a scene shows light leaking through a blocker.
- **Add a second bounce instead**: Shade the blocker once, so mirror-in-mirror stays lit. More cost and work.

Maintainer's note: We may document this as well so if users are doing complex mirror in mirror (like our own example) we can turn this on

Outcome: Kept off by default. Making it a setting, documented for mirror-in-mirror scenes, is part of the settings-guide tracked fix.

## Sponza with RT reads 1.3 worse against the path tracer with specAA on. Accept for now?

<a id="sponza-rt-specaa"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W46 · **Recommended:** Accept, re-measure later · **Answer:** Accept, re-measure later

Sponza + RT goes from 27.21 to 28.53 MAD, and the polished floor blurs and brightens a little at distance (mid band 106 → 113, path tracer 87). Sponza is already much brighter than the path tracer in shade, so this delta can't be judged on its own yet.

Options:
- **Accept, re-measure later** (chosen): It stays in the backlog until Sponza's shade bias is fixed.
- **Investigate now**: An agent digs into Sponza's shade bias and this delta together.

Maintainer's note: We can investigate but this lib isnt a pathtracer or GI setup. so the lighting issues may come from larger things. If its just reflections we are talking about and comparing then we can address, but the way you phrase it makes me think its a wider thing.

Outcome: Agreed, it's lighting, not reflections: Sponza's gap is raster lighting without GI. Backlog note: judge reflection changes there on reflection-heavy pixels or against reflections off, so the lighting gap doesn't hide or fake them.

## Keep roughness-from-normal-variance on by default in the examples?

<a id="specaa-default"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W46 · D3570 · **Recommended:** Keep it on · **Answer:** Keep it on

`?specAA` raises roughness where a normal map's detail averages out at a distance, which is what the path tracer does by supersampling. carConcept's door / skirt went from 155 / 42 to 194 / 53 (path tracer 197 / 60). toyCar and chess don't change, and it costs about 0.1–0.15 ms. It moves every showcase and compare baseline, so older numbers need `?specAA=0`.

Options:
- **Keep it on** (chosen): The examples match the path tracer's look; `?specAA=0` or the checkbox shows the authored materials.
- **Default off, opt in**: The examples show the assets as authored; turn it on to compare.

Maintainer's note: The only concern for me is the cost. little things like this add up, so we should doccument that fact, especially if we do a "fast" mode or something later.

Outcome: Stays on. The settings guide will list each option's GPU cost (specAA ~0.1–0.15 ms) for a later 'fast' preset.

## How much blur at reflection hits (hitLobeFilter)?

<a id="lobe-filter"></a>
**Status:** closed (answered 2026-11-12) · **Source:** W45 · D3550 · **Recommended:** Keep 1 (default) · **Answer:** Keep 1 (default)

`hitLobeFilter` stops the denoiser throwing away bright glossy samples by blurring what each hit reads by the reflecting surface's roughness. On a mirror that's almost no blur, so the floor's reflection of the car stays sharp. It only softens a glossy surface seen through a mirror. You asked what most people would want; 1 is the principled default.

Options:
- **Keep 1 (default)** (chosen): Door / skirt MAD vs the path tracer 35.6 / 19.0 against 44.2 / 39.1 at 0. One ray stands for a cone its own lobe wide.
- **Raise to 1.5**: Skirt closer to the path tracer (MAD 4.1 vs 7.7 in the rough-paint test), but glossy reflections through mirrors get visibly softer.
- **Off by default (0)**: Sharpest, and loses 26–46% of glossy energy to the denoiser until pmndrs/denoiser#28 is fixed.

Maintainer's note: We may want to doccument/note this and provide it as an option. I support the default as 1

Outcome: Default stays 1. It's already a setting (`hitLobeFilter`, 0 turns it off). A settings guide with its trade-offs, plus a showcase slider and `?lobeFilter=`, is now a tracked fix in HANDOFF.

## File the three.js issue about stock materials and node properties?

<a id="three-issue"></a>
**Status:** closed (answered 2026-11-12) · **Source:** D3572 · **Recommended:** File it as drafted · **Answer:** File it as drafted

On r187, two stock materials that differ only in a `*Node` property (like `colorNode` or `roughnessNode`) share one compiled shader, so the second renders with the first's node. A minimal repro confirmed it: the right square is red instead of blue, and `MeshBasicNodeMaterial` is correct. The draft is in `docs/upstream/three-stock-material-node-cache-key.md`, and a standalone repro page sits beside it. W46 already works around it in the examples.

Options:
- **File it as drafted** (chosen): The lead opens it on mrdoob/three.js and links it from D3572.
- **I'll edit the draft first**: Put your changes in the note, or edit the file, and the lead files it after.
- **Don't file**: Keep the workaround and note it in D3572 only.

Maintainer's note: I filed the issue

Outcome: Filed as mrdoob/three.js#35485. D3572 and the draft now link it.
