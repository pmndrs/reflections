import sys, json
import numpy as np
from PIL import Image
# metrics.py ref.png name=file ... ; regions in 960x540 coords of view V1 (scaled if the image is bigger)
ref_f = sys.argv[1]
L = lambda a: 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
def load(f): return np.asarray(Image.open(f).convert('RGB'), dtype=np.float64)
R = load(ref_f); H, W = R.shape[:2]; s = W / 960
def rect(x0, y0, x1, y1):
    m = np.zeros((H, W), bool); m[int(y0 * s):int(y1 * s), int(x0 * s):int(x1 * s)] = True; return m
lr = L(R)
def lip():
    # the skirt's lower lip on the car: the 10 px above the top of the PT's dark band, per column x 460-640
    m = np.zeros((H, W), bool)
    for x in range(460, 640):
        col = lr[280:400, x] < 15
        best, start, run0 = 0, None, None
        for y in range(len(col) + 1):
            if y < len(col) and col[y]:
                run0 = y if run0 is None else run0
            else:
                if run0 is not None and y - run0 > best: best, start = y - run0, run0
                run0 = None
        if start is not None and best >= 6:
            m[280 + start - 8:280 + start, x] = True
            BAND[280 + start:280 + start + best, x] = True
    return m
BAND = np.zeros((H, W), bool)
def band(): return BAND
regions = {
    'skirtLip': lip(),
    # the dark band under the door / skirt (floor reflection of the car's underside): PT luma < 25 there
    'halo': band(),
    'wheelRefl': rect(290, 410, 400, 500),      # the front wheel reflected in the floor
    'doorRefl': rect(470, 395, 640, 445) & (lr > 60),  # the red door reflected in the floor
    'carRefl': rect(170, 380, 780, 520),         # the whole floor reflection of the car
}
def hf(img, m):
    # detail: mean |Laplacian| of luma inside the mask
    l = L(img); lap = np.abs(4 * l[1:-1, 1:-1] - l[:-2, 1:-1] - l[2:, 1:-1] - l[1:-1, :-2] - l[1:-1, 2:])
    return float(lap[m[1:-1, 1:-1]].mean())
out = {'_px': {k: int(v.sum()) for k, v in regions.items()}}
out['PT'] = {k: {'luma': round(float(lr[m].mean()), 1), 'std': round(float(lr[m].std()), 1), 'hf': round(hf(R, m), 2)} for k, m in regions.items()}
for a in sys.argv[2:]:
    n, f = a.split('=', 1); X = load(f); lx = L(X)
    out[n] = {k: {'luma': round(float(lx[m].mean()), 1), 'std': round(float(lx[m].std()), 1), 'mad': round(float(np.abs(X - R)[m].mean()), 2), 'hf': round(hf(X, m), 2)} for k, m in regions.items()}
w = max(len(k) for k in out)
print('px', out['_px'])
print(f"{'':{w}}  " + '  '.join(f'{k:>24}' for k in regions))
print(f"{'':{w}}  " + '  '.join(f"{'luma/MAD/detail/std':>24}" for k in regions))
for n, r in out.items():
    if n == '_px': continue
    print(f'{n:{w}}  ' + '  '.join(f"{r[k]['luma']:>6}/{r[k].get('mad', '-'):>6}/{r[k]['hf']:>5}/{r[k]['std']:>5}" for k in regions))
