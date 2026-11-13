# W58: load a readback.js dump (crop x 440-680, y 270-420 at 960x540) and the bench's PT shot; W50's lip / band masks.
import os
import numpy as np
from PIL import Image

X0, Y0, CW, CH = 440, 270, 240, 150


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def load(d, tag, k=0):
    def f(n, c):
        a = np.fromfile(os.path.join(d, f'{tag}-{k}-{n}.f32'), np.float32)
        return a.reshape(CH, CW, c) if c > 1 else a.reshape(CH, CW)
    out = dict(src=f('src', 1), conf=f('conf', 1), hd=f('hd', 1), rad=f('rad', 4), sig=f('sig', 4), nr=f('nr', 4))
    p = os.path.join(d, f'{tag}-final.png')
    if os.path.exists(p):
        out['final'] = np.asarray(Image.open(p).convert('RGB'), np.float32)[Y0:Y0 + CH, X0:X0 + CW]
    return out


def masks(pt_full):
    """W50's lip / band at 960x540 (bench regions.ts): per column x 460-640, rows 280-400, the longest
    run of PT luma < 15 (>= 6 px); lip = the 8 px above it. Full-frame boolean masks."""
    L = luma(pt_full)
    band = np.zeros(L.shape, bool)
    lip = np.zeros(L.shape, bool)
    for x in range(460, 640):
        best, start, run0 = 0, -1, -1
        for y in range(280, 401):
            dark = y < 400 and L[y, x] < 15
            if dark:
                if run0 < 0:
                    run0 = y
            else:
                if run0 >= 0 and y - run0 > best:
                    best, start = y - run0, run0
                run0 = -1
        if start < 0 or best < 6:
            continue
        band[start:start + best, x] = True
        lip[max(0, start - 8):start, x] = True
    return lip, band
