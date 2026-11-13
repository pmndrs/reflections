# W76: the march's depth lookup past the last whole texel (D5100)

**Verdict: real, small, reverse-Z only. Fixed in `marchStep` (clamp on screen); forward-Z unchanged within the run-to-run noise.**

## Suspect

`marchStep` reads the pyramid at `vec2i(current_mip_resolution * position.xy)` with `current_mip_resolution = screen_size * 0.5^mip`. The pyramid's mips are floor-sized (the last texel of an odd level also covers the leftover row / column, D1600), so where the screen size is not a multiple of 2^mip the last strip maps one texel past the mip. `loadDepth` returns 0 there (D303). 0 is "nearest" under forward-Z (the march steps down a mip) and "farthest" under reverse-Z (`above_surface` is true, the cell reads empty, the ray skips the strip and leaves the screen).

Strip heights (rows of the screen that map past the mip): 1080p mips 4 / 5 / 6 = 8 / 24 / 56 px; 540p mips 3 / 4 / 5 / 6 = 4 / 12 / 28 / 28 px.

## Repro

`examples/ssr` got `?reversedDepth=1` (three's `reversedDepthBuffer`) and two hooks (`__p.bandProfile`, `__p.setFlipped`; debug only). Same view, forward-Z vs reverse-Z, hit mask = `outputs.confidence > 0.01` per pixel, 960x540 and 1920x1080, every scene and pose of the page (28) plus flipped-camera and mirror-wall variants of `mirrorWall`. The hit mask at the *origin* pixel is what a lost ray removes. Two runs of the same code differ by 100-700 px (glossy sampling is not bit-stable between page loads), so only losses well above that count.

Where the rays start in the bottom band (my first per-row profile of the origin rows) there was no difference: a ray that starts there leaves the band before it climbs to mip 5-6. The loss is at the other end, the rays that *arrive* in the band: a ray that has climbed to a coarse mip while still above the surface, and whose next cell is in the strip. Under reverse-Z the strip reads far and the ray flies past a surface it would have hit.

Hit pixels, forward-Z vs reverse-Z (before the fix):

| scene / pose | size | forward | reverse | forward-only | reverse-only |
|---|---|---|---|---|---|
| facingMirrors / left | 960x540 | 158695 | 154260 | 4465 | 33 |
| facingMirrors / left | 1920x1080 | 635086 | 617859 | 17303 | 76 |
| mirrorWall / lowSphere | 960x540 | 222537 | 221833 | 724 | 20 |
| mirrorWall / lowSphere | 1920x1080 | 892633 | 890431 | 2365 | 163 |
| rooms / doorway | 1920x1080 | 274951 | 271934 | 5227 | 2210 |
| the other poses | both | | | within the noise (symmetric) | |

`facingMirrors/left` is two facing mirrors seen at a grazing angle: long rays that cross most of the screen along the surface, which is the case the strip hurts.

## Fix

```wgsl
fn marchStep(m: ptr<function, March>, occupancy: u32) {
  let current_mip_position = (*m).current_mip_resolution * (*m).position.xy;
  var depth_texel = vec2i(current_mip_position);
  if (all((*m).position.xy >= vec2f(0.0)) && all((*m).position.xy < vec2f(1.0))) {
    depth_texel = min(depth_texel, vec2i(textureDimensions(t_depth_hierarchy, (*m).current_mip)) - vec2i(1));
  }
  let surface_z = loadDepth(depth_texel, (*m).current_mip);
  ...
```

Off-screen positions keep D303's 0. The clamp is the pyramid's own rule (the last texel covers the remainder). The other `loadDepth` callers are left alone: `validateHit` reads mip 1 at `texel / 2` (in range for even sizes; an odd last row returns 0 for the background test only, FFX's lookup, kept) and the hit mip at the hit's own mip position (a hit inside the last strip reads the clamped last texel only if it is in range, which it is: the hit's mip is its ray's most detailed mip, 0 or 1); `marchInit` loads no depth (the origin depth is the pixel's own mip-0 value).

## After

Reverse-Z against forward-Z (after the fix, same views):

| scene / pose | size | forward | reverse | forward-only | reverse-only |
|---|---|---|---|---|---|
| facingMirrors / left | 960x540 | 158595 | 158480 | 148 | 33 |
| facingMirrors / left | 1920x1080 | 634886 | 634454 | 567 | 135 |
| mirrorWall / lowSphere | 960x540 | 222238 | 221902 | 380 | 44 |
| mirrorWall / lowSphere | 1920x1080 | 891578 | 890642 | 1100 | 164 |
| rooms / doorway | 1920x1080 | 275183 | 275057 | 1988 | 1862 |

Reverse before vs after: `facingMirrors/left` +16631 hit pixels at 1080p (+4221 at 540p). Forward before vs after: noise-sized everywhere (`facingMirrors/left` 412 / 212 px of 635086); `mirrorWall/lowSphere` has 1572 forward-only vs 517 after-only at 1080p (0.12 % of its hit pixels, 419 / 120 at 540p): with the clamp a coarse cell now answers where the 0 used to force a finer mip, so a few grazing rays that the descent happened to catch (or that it overstepped) differ. Not pixel-identical, not systematically worse; the remaining forward / reverse gap on `lowSphere` is the same set.

## Cost

Intersect GPU ms at 1080p, `examples/sssr-core`, loop stopped, median of 40, three repeats per run, the GPU shared with five other worktrees (so only coarse): forward before 0.44-0.51, after 0.48-0.65; reverse before 0.48-1.4, after 0.49-0.66. One extra `textureDimensions`, one `min` and a bounds test per march step: no cost measurable above the noise. Re-time on a quiet GPU if it matters (backlog).

## Checks

`pnpm typecheck`, `pnpm test` (64), `--only sssr-core` (incl. reverse-Z hit fraction and parity), full `pnpm check`: see the HANDOFF row.
