# W58: lip / band pixels whose 2x2 quad base (spq 1: the even-even pixel) is on another surface
# (G-buffer normal dot < 0.9 or roughness differs by > 0.1): they show the base's ray (quad copy).
# python3 cross.py <readback dir> <tag> <pt.png>
import sys
import numpy as np
from PIL import Image
from load import load, masks, luma, X0, Y0, CW, CH

d, tag, ptp = sys.argv[1:4]
a = load(d, tag)
pt = np.asarray(Image.open(ptp).convert('RGB'), np.float32)
lip, band = masks(pt)
nr = a['nr']
n = nr[..., :3] / np.maximum(1e-6, np.linalg.norm(nr[..., :3], axis=-1, keepdims=True))
ys, xs = np.mgrid[0:CH, 0:CW]
gy, gx = ys + Y0, xs + X0
by, bx = (gy & ~1) - Y0, (gx & ~1) - X0
by, bx = np.clip(by, 0, CH - 1), np.clip(bx, 0, CW - 1)
cross = ((n * n[by, bx]).sum(-1) < 0.9) | (np.abs(nr[..., 3] - nr[by, bx, 3]) > 0.1)
F = luma(a['final'])
PT = luma(pt[Y0:Y0 + CH, X0:X0 + CW])
for name, m in (('lip', lip), ('band', band)):
    m = m[Y0:Y0 + CH, X0:X0 + CW]
    for sub, s in (('all', m), ('quad base on another surface', m & cross), ('same surface', m & ~cross)):
        k = s.sum()
        if not k: continue
        print(f'{name:5} {sub:30} {k:5d} px  ours {F[s].mean():6.1f}  PT {PT[s].mean():6.1f}  |diff| {np.abs(F[s] - PT[s]).mean():6.1f}  share of |diff| sum {np.abs(F[s] - PT[s]).sum() / max(1e-6, np.abs(F[m] - PT[m]).sum()):.2f}')
