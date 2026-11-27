# W101: `minTraversalOccupancy` 0 vs 4 (FFX's glossy early exit): rest flicker vs GPU ms

**Decision:** core's default is now 0 (was 4), for every adapter (D5560). The exit made a still frame trace
differently on every dispatch. Turning it off lowers or keeps every flicker number we measure, and makes the
repeats identical. It costs +0.05-0.14 ms of intersect at 1080p on glossy scenes, 2-6 % of the tracer. The
'performance' preset doesn't keep the exit: at half res it saves only 0.03-0.06 ms, and the quickstart's
rt + performance rest flicker is the same either way. Babylon keeps its own explicit 0 (D5521).

Why the exit flickers (W99): classify appends rays to the ray list with atomics, so which rays share a subgroup
changes every dispatch. The early exit stops a glossy ray once 4 or fewer rays of its subgroup still march.
So the step where a ray stops changes too, even with `frameIndex` pinned.

Method: A/B in this worktree and session, configs alternating (ABBA), loop stopped for timings. Port 5423.
Scripts are in [scripts/](scripts/).

## 1. Check-based rest numbers ([ab-checks.txt](ab-checks.txt), [ab-engines-4dp.txt](ab-engines-4dp.txt))

`ab-checks.sh` flips core's `?? N` default and runs `--only quickstart` / `--only engines`. There were 4 rounds per
config. For the second file the engines print was patched to 4 decimals for the run, then reverted.

| page | occ 4 | occ 0 |
|---|---|---|
| quickstart (% px > 1/255 between frames) | 0.296 / 0.297 / 0.315 / 0.322 | 0.241 / 0.247 / 0.248 / 0.251 |
| quickstart rt, default limits | 0.370-0.379 | 0.347-0.372 |
| quickstart rt + preset performance | 0.649-0.698 | 0.651-0.712 (same) |
| engines three default (mean /255) | 0.0078-0.0081 | 0.0072-0.0075 |
| engines three table | 0.0077-0.0079 | 0.0072-0.0076 |
| engines r3f default / table | 0.0080-0.0081 / 0.0076-0.0078 | 0.0072-0.0077 / 0.0073 |
| engines core default / table | 0.0083-0.0085 / 0.0083-0.0086 | 0.0079 / 0.0077 (identical each round) |
| engines babylon | 0.0000 | 0.0000 (pinned 0 already) |

The engines' max (2-13 /255) is the same under both configs, so it doesn't come from this setting. The remaining
~0.007 /255 on the denoised pages doesn't come from the tracer's exit either.

## 2. `--only flicker` ([flicker-summary.md](flicker-summary.md), [flicker/](flicker/))

These are the 7 standard scenes. There were 3 runs per config, in the order 4 0 0 4 4 0, one check per run
(the check's 10-minute limit). Each cell is the reflection region's mean over the 3 runs.

| scene | drift 4 -> 0 | orbit std 4 -> 0 | speckle % 4 -> 0 | rest 4 -> 0 |
|---|---|---|---|---|
| ssr:contact | 0.376 -> 0.367 (-2.4 %) | 0.476 -> 0.451 (-5.2 %) | 0.0166 -> 0.0158 | 0.0067 -> 0.0066 |
| ssr:mirrorWall | 0.308 -> 0.305 | 0.459 -> 0.464 (inside occ 4's 0.454-0.463) | 0.0162 -> 0.0154 | 0.0094 = |
| bench:cubeFloor / edgesFloor / plateFloor | within 0.1-1.8 % | within 1 % | = | = |
| bench:carConcept@w50 | 0.269 -> 0.267 (-0.8 %) | 0.392 -> 0.382 (-2.5 %) | 0.0576 -> 0.0563 | 0.0073 -> 0.0074 |
| bench:sponza@hero | 0.301 -> 0.300 | 0.554 = | 0.357 -> 0.334 (-6.4 %) | 0.0114 -> 0.0112 |

The occ 0 repeats are identical from run to run. The occ 4 repeats vary.

## 3. In-page rest flicker and image change ([image-rest.md](image-rest.md))

`image.js` runs at 960x540 with 3 runs per config, alternating. Each run drops the history, renders 90 frames,
then measures the change over 8 consecutive frames. The image comparison is the last frame, 4 vs 0, next to the
same config's own repeat (the noise floor).

| scene | rest mean /255, 4 -> 0 | % px > 1, 4 -> 0 | image 4 vs 0 (mean / max / % px > 8) | noise floor |
|---|---|---|---|---|
| contact | 0.039-0.041 -> 0.033-0.034 | 0.46-0.54 -> 0.37-0.40 | 0.18-0.19 / 46-66 / 0.39-0.43 | 0.09-0.11 / 20-27 / 0.03-0.06 |
| contact rt | 0.058-0.060 -> 0.058-0.060 | 0.52-0.54 -> 0.51-0.54 | 0.16 / 61-73 / 0.07 | 0.14-0.16 / 31-60 / 0.04-0.06 |
| mirrorWall (rt or not) | 0.0014-0.0015 both | 0.013-0.021 both | at the noise floor | |
| sponza | 0.0123-0.0133 -> 0.0124-0.0126 (max 3-7 -> 3-4) | 0 | 0.14-0.18 / 25 | 0.01-0.17 (one reset seed differs) |
| carConcept | 0.0066-0.0071 both (max 7-29 -> 8-12) | 0.002-0.004 -> 0.001 | 0.13-0.17 / 26-41 / 0.04-0.09 | 0.08-0.16 / 17-36 |

The image does change at rest. On contact, marching to the end finds hits that the exit dropped: 0.4 % of pixels
move by more than 8/255, about twice the noise floor's mean. On the other scenes the change is at their noise
floor. With RT on, the traced pass picks up what the exit dropped anyway, so contact rt doesn't change.

## 4. GPU ms at 1080p ([timing-1080p.md](timing-1080p.md), [timing-1080p.jsonl](timing-1080p.jsonl))

`timing.js`: 6 rounds x 30 frames per config, alternating inside one page, loop stopped. The table gives medians.
mirrorWall and contact run on examples/ssr, Sponza and carConcept on the showcase.

| scene | rt | intersect 4 -> 0 ms | delta | core passes 4 / 0 |
|---|---|---|---|---|
| mirrorWall | 0 | 1.967 -> 1.969 | 0 (mirror rays ignore it) | 4.11 / 3.96 |
| mirrorWall | 1 | 1.769 -> 1.600 | -0.17 (noise) | 3.71 / 3.26 |
| contact | 0 | 0.682 -> 0.792 | +0.110 (+16 %) | 2.40 / 2.45 |
| contact | 1 | 0.593 -> 0.657 | +0.064 (+11 %) | 2.99 / 2.99 |
| sponza | 0 | 0.483 -> 0.534 | +0.051 (+11 %) | 2.90 / 2.81 |
| sponza | 1 | 0.463 -> 0.512 | +0.049 (+11 %) | 4.34 / 4.20 |
| carConcept | 0 | 0.690 -> 0.834 | +0.144 (+21 %) | 2.52 / 2.67 |
| carConcept | 1 | 0.625 -> 0.709 | +0.084 (+13 %) | 5.46 / 5.50 |
| half res (performance / `res=half`), rt | 1 | 0.14-0.43 -> 0.19-0.49 | +0.03-0.06 (carConcept 0) | |

The frame sums (three's passes + core + denoiser) moved by up to 3 ms between rounds on the shared GPU. The
setting's change is inside that noise, so the frame sums support no conclusion either way. The intersect pass
is the number that counts: +0.05-0.14 ms, which is 2-6 % of the core passes and under the ~10 % bar.

## Checks after the change ([checks/](checks/))

These all pass on the new default: `--only quickstart`, `ssr`, `ssr-rt`, `hybrid`, `engines`, `showcase` and `sssr-core`. The logs are in [checks/](checks/). On the new default, quickstart reads 0.246 % of px, and the engines page reads three 0.007 / 255 and core 0.008 / 255. In sssr-core, the variant-parity case for the ray lists now asks for occupancy 4 explicitly, so it still covers the exit. `--only catalog` failed once on the babylon lab page with 'page not ready'. That page passed when run alone and on a full rerun ([catalog-rerun.txt](checks/catalog-rerun.txt)). Babylon already pins 0, so this change can't affect it. typecheck, test (127) and build pass.

## Not done

- A deterministic ray-list order (sort it, or give each tile fixed slots) would bring back the exit's saving
  without the flicker. This is the revisit trigger in D5560.
- The remaining ~0.007 /255 rest change on the denoised engine pages has another source. This setting doesn't
  touch it.
