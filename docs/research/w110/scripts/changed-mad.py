"""W110: MAD vs the PT (8-bit display, mean over RGB) of measure.js's means, over the frame, an optional rect, and the pixels
a pair of configurations differ in (|a - b| > threshold in any channel, the 'changed' mask).
python3 -I changed-mad.py <dir> <pose> <maskA> <maskB> [configs...] [--rect x0,y0,x1,y1] [--thr 2]"""
import sys
from PIL import Image

args = sys.argv[1:]
rect, thr = None, 2.0
if '--rect' in args:
    i = args.index('--rect'); rect = tuple(map(int, args[i + 1].split(','))); del args[i:i + 2]
if '--thr' in args:
    i = args.index('--thr'); thr = float(args[i + 1]); del args[i:i + 2]
d, pose, ma, mb, *rest = args
names = list(dict.fromkeys([ma, mb, *rest]))
load = lambda k: list(Image.open(f'{d}/{pose}-{k}.png').convert('RGB').get_flattened_data())
W, H = Image.open(f'{d}/{pose}-pt.png').size
P = load('pt')
imgs = {k: load(k) for k in names}
A, B = imgs[ma], imgs[mb]
sets = {'frame': range(W * H)}
if rect:
    x0, y0, x1, y1 = rect
    sets['rect'] = [y * W + x for y in range(y0, y1) for x in range(x0, x1)]
sets['changed'] = [i for i in range(W * H) if max(abs(A[i][c] - B[i][c]) for c in range(3)) > thr]
luma = lambda img, idx: sum(0.2126 * img[i][0] + 0.7152 * img[i][1] + 0.0722 * img[i][2] for i in idx) / max(1, len(idx))
mad = lambda img, idx: sum(sum(abs(img[i][c] - P[i][c]) for c in range(3)) / 3 for i in idx) / max(1, len(idx))
for s, idx in sets.items():
    idx = list(idx)
    cells = '  '.join(f'{k} {luma(imgs[k], idx):6.1f} / {mad(imgs[k], idx):6.2f}' for k in names)
    print(f'{pose} {s:8s} px {len(idx):7d}  PT {luma(P, idx):6.1f}  {cells}')
