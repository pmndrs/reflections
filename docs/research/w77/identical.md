# W77: no preset = main HEAD, bit for bit

Branch at `3c91933` (every review fix in) vs main `22adc27`, one worktree, port 5449, one server. Setup: [scripts/identical.sh](scripts/identical.sh), W75's setup:
- frameIndex 5, minTraversalOccupancy 0;
- the ssr page, raw and denoised, on offscreen / contact / mirrorWall / facingMirrors / moving, with RT;
- the showcase's carConcept with RT.

Result: the raw-output hashes (radiance, hit distance, confidence, rt source) are equal on every scene, and the final images differ by 0/255 on 0 px.

```
car-carConcept.png max 0 /255, px > 0: 0
dn-contact.png max 0 /255, px > 0: 0
dn-facingMirrors.png max 0 /255, px > 0: 0
dn-mirrorWall.png max 0 /255, px > 0: 0
dn-moving.png max 0 /255, px > 0: 0
dn-offscreen.png max 0 /255, px > 0: 0
raw-contact.png max 0 /255, px > 0: 0
raw-facingMirrors.png max 0 /255, px > 0: 0
raw-mirrorWall.png max 0 /255, px > 0: 0
raw-moving.png max 0 /255, px > 0: 0
raw-offscreen.png max 0 /255, px > 0: 0
```
