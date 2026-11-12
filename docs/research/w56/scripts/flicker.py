# W56: frame-to-frame flicker over flicker.js's frames. python3 -I flicker.py <frameDir> <ptPng> <masksA> name ...
# Per px: the std of 8-bit luma over the frames, and the mean |frame i - frame i-1|; reported as the mean over:
#   paint:     px whose PT colour is red paint (r > 80, r > 1.6 g) above the floor line (y < 1000; the car itself)
#   paintRefl: the same red test below it (y >= 1000; the car's paint reflected in the floor)
#   floor:     the open floor in the PT (grey, r ~ g ~ b, luma > 100) at y >= 1000
#   star:      Rim2 on the front wheel (masks-a)
#   frame:     every px
import sys, glob
import numpy as np
from PIL import Image

d, pt_path, ma_path = sys.argv[1], sys.argv[2], sys.argv[3]
L = lambda p: np.asarray(Image.open(p).convert('RGB')).astype(np.float64)
pt = L(pt_path)
lum = lambda im: im @ np.array([0.2126, 0.7152, 0.0722])
red = (pt[..., 0] > 80) & (pt[..., 0] > 1.6 * pt[..., 1])
ys = np.arange(pt.shape[0])[:, None] * np.ones((1, pt.shape[1]))
grey = (np.abs(pt[..., 0] - pt[..., 2]) < 12) & (lum(pt) > 100)
a = L(ma_path) > 127
box = np.zeros(a.shape[:2], bool); box[660:1000, 180:520] = True
masks = {'paint': red & (ys < 1000), 'paintRefl': red & (ys >= 1000), 'floor': grey & (ys >= 1000), 'star': a[..., 1] & ~a[..., 0] & box, 'frame': np.ones(pt.shape[:2], bool)}
print(f"{'':18}" + ''.join(f'{k + " (" + str(int(m.sum())) + ")":>22}' for k, m in masks.items()))
print(f"{'':18}" + ''.join(f'{"std / |dF|":>22}' for _ in masks))
for n in sys.argv[4:]:
    fs = sorted(glob.glob(f'{d}/{n}-f*.png'), key=lambda p: int(p.rsplit('-f', 1)[1][:-4]))
    st = np.stack([lum(L(p)) for p in fs])
    std = st.std(axis=0)
    df = np.abs(np.diff(st, axis=0)).mean(axis=0)
    print(f'{n:18}' + ''.join(f'{std[m].mean():10.3f} / {df[m].mean():7.3f}  ' for m in masks.values()))
