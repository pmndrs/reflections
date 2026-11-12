# W56: mean 8-bit luma and MAD vs the path tracer at W50's camera, 1280 x 1280, over the chrome star and
# the regions around it. python3 -I stats.py <shotDir> name[@reference] ...  (reference: default pathtraced)
# <shotDir> holds masks-a.png / masks-b.png (W54's masks.js at the same camera; copies in w54/scripts).
#   star:       Rim2 (chrome) px on the front wheel (masks-a G, x 180-520, y 660-1000), as W54's `hub` mask
#   starCore:   the star px at least 2 px from any non-star px (the faces, not the bevels' silhouette)
#   starEdge:   star px within 2 px of a non-star px
#   hubRect:    W54's `hub` region (255-395 x 758-882)
#   floorUnder: the floor seen under the car (x 0-1280, y 880-1120) where the PT is dark (luma < 15), as W50's `band`
#   star>floor / star>sky / star>wheel: the star px by where its mirror ray goes (rays.png from rays.js, if present)
#   floorWheel: W54's floor-reflected front wheel (200-500 x 990-1230)
#   frame:      every px
import sys
import numpy as np
from PIL import Image

d = sys.argv[1]
load = lambda n: np.asarray(Image.open(f'{d}/{n}.png').convert('RGB')).astype(np.float64)
a, b = load('masks-a') > 127, load('masks-b') > 127
box = np.zeros(a.shape[:2], bool); box[660:1000, 180:520] = True
star = a[..., 1] & ~a[..., 0] & box
# 2 px erosion of the star mask
core = star.copy()
for dy in (-2, -1, 0, 1, 2):
    for dx in (-2, -1, 0, 1, 2):
        core &= np.roll(np.roll(star, dy, 0), dx, 1)
rect = lambda x0, y0, x1, y1: (lambda m: (m.__setitem__((slice(y0, y1), slice(x0, x1)), True), m)[1])(np.zeros(a.shape[:2], bool))
luma = lambda im: im @ np.array([0.2126, 0.7152, 0.0722])
masks = {
    'star': star,
    'starCore': core,
    'starEdge': star & ~core,
    'hubRect': rect(255, 758, 395, 882),
    'floorUnder': rect(0, 880, 1280, 1120) & (luma(load('pathtraced')) < 15),
    'floorWheel': rect(200, 990, 500, 1230),
    'frame': np.ones(a.shape[:2], bool),
}
import os
if os.path.exists(f'{d}/rays.png'):
    ry = load('rays')
    masks['star>floor'] = star & (ry[..., 0] > 127) & (ry[..., 1] > 127) & (ry[..., 2] < 128)
    masks['star>sky'] = star & (ry[..., 0] > 127) & (ry[..., 1] > 127) & (ry[..., 2] > 127)
    masks['star>wheel'] = star & (ry[..., 0] < 128) & (ry[..., 1] > 127) & (ry[..., 2] < 128)
print(f"{'':26}" + ''.join(f'{k + " (" + str(int(m.sum())) + ")":>18}' for k, m in masks.items()))
for arg in sys.argv[2:]:
    n, r = arg.split('@') if '@' in arg else (arg, 'pathtraced')
    im, ref = load(n), load(r)
    cells = []
    for m in masks.values():
        l = luma(im)[m].mean()
        mad = np.abs(im - ref).mean(axis=2)[m].mean()
        cells.append(f'{l:6.1f} / {mad:5.1f}')
    print(f'{n:26}' + ''.join(f'{c:>18}' for c in cells))
