# W54: mean 8-bit luma and MAD vs the path tracer over material masks (masks.js) at W50's camera, 1280 x 1280.
# python3 -I stats.py <shotDir> name[@reference] ...  (reference: default pathtraced)
#   hub:     Rim2 (chrome) on the front wheel (masks-a G, x 180-520, y 660-1000)
#   wheel:   Disc / Brake / Mechanical inside the front wheel (masks-a R, same box)
#   cabin:   the cabin's interior materials seen through glass (masks-b R and masks-a B)
#   glass:   every glass pixel (masks-a B)
#   rim1:    the black spokes and rim lip on the front wheel (masks-b G, same box)
import sys
import numpy as np
from PIL import Image

d = sys.argv[1]
load = lambda n: np.asarray(Image.open(f'{d}/{n}.png').convert('RGB')).astype(np.float64)
a, b = load('masks-a') > 127, load('masks-b') > 127
box = np.zeros(a.shape[:2], bool); box[660:1000, 180:520] = True
masks = {
    'hub': a[..., 1] & ~a[..., 0] & box,
    'wheel': a[..., 0] & ~a[..., 1] & box,
    'rim1': b[..., 1] & ~b[..., 0] & box,
    'cabin': b[..., 0] & ~b[..., 1] & a[..., 2] & ~a[..., 0],
    'glass': a[..., 2] & ~a[..., 0] & ~a[..., 1],
}
ref = load('pathtraced')
luma = lambda im: im @ np.array([0.2126, 0.7152, 0.0722])
print(f"{'':22}" + ''.join(f'{k + " (" + str(int(m.sum())) + ")":>20}' for k, m in masks.items()))
for arg in sys.argv[2:]:
    n, r = arg.split('@') if '@' in arg else (arg, 'pathtraced')
    im, ref = load(n), load(r)
    cells = []
    for m in masks.values():
        l = luma(im)[m].mean()
        mad = np.abs(im - ref).mean(axis=2)[m].mean()
        cells.append(f'{l:6.1f} / {mad:5.1f}')
    print(f'{n:22}' + ''.join(f'{c:>20}' for c in cells))
