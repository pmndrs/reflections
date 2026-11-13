# W58: per-pixel table down a few columns crossing the lip / band edge.
# python3 columns.py <readback dir> <tag> <pt.png> [x ...]
import sys
import numpy as np
from PIL import Image
from load import load, masks, luma, X0, Y0

d, tag, ptp = sys.argv[1:4]
xs = [int(v) for v in sys.argv[4:]] or [500, 501, 560, 561, 620]
a = load(d, tag)
pt = np.asarray(Image.open(ptp).convert('RGB'), np.float32)
lip, band = masks(pt)
NAMES = {0: 'ssr', 1: 'T-hit', 2: 'T-miss', 3: 'capped', 4: 'T-scr'}
for x in xs:
    ys = np.where(band[:, x])[0]
    if not len(ys):
        print('col', x, 'no band'); continue
    y0 = ys[0]
    print(f'\ncol {x}: band rows {ys[0]}-{ys[-1]}, lip rows {y0 - 8}-{y0 - 1}')
    print('   y  reg  quad  src     conf   hitd   sigLum  radLum  rough  nY     final  PT')
    for y in range(y0 - 10, y0 + 6):
        cx, cy = x - X0, y - Y0
        s = int(round(a['src'][cy, cx])); c = a['conf'][cy, cx]
        cls = NAMES.get(s, s) if s else ('ssr' if c > 0 else 'probe')
        reg = 'lip' if lip[y, x] else 'band' if band[y, x] else ''
        q = f'{x & 1}{y & 1}'
        print(f'{y:4d} {reg:>4} {q:>5} {cls:>7} {c:7.3f} {a["hd"][cy, cx]:6.3f} {luma(a["sig"][cy, cx]):7.3f} {luma(a["rad"][cy, cx]):7.3f} {a["nr"][cy, cx, 3]:6.3f} {a["nr"][cy, cx, 1]:5.2f} {luma(a["final"][cy, cx]):7.1f} {luma(pt[y, x]):5.1f}')
