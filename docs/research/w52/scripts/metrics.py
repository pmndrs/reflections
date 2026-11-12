# W52 metrics: W50's regions (docs/research/w50/scripts/metrics.py) plus wider underside regions.
# python3 metrics.py ref.png name=file ... [--json out.json]
# Regions in 960x540 coords of W50's view (scaled when the images are bigger). 8-bit sRGB luma
# after AgX; MAD over RGB vs the reference (the path tracer).
import sys, json
import numpy as np
from PIL import Image
argv = sys.argv[1:]
jout = None
if '--json' in argv:
    i = argv.index('--json'); jout = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
ref_f = argv[0]
L = lambda a: 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
def load(f): return np.asarray(Image.open(f).convert('RGB'), dtype=np.float64)
R = load(ref_f); H, W = R.shape[:2]; s = W / 960
lr = L(R)
def rect(x0, y0, x1, y1):
    m = np.zeros((H, W), bool); m[int(y0 * s):int(y1 * s), int(x0 * s):int(x1 * s)] = True; return m
BAND = np.zeros((H, W), bool)
def lip():
    # W50: the skirt's lower lip on the car, the 8 px above the PT's dark band (longest run of luma < 15), x 460-640
    m = np.zeros((H, W), bool)
    for x in range(int(460 * s), int(640 * s)):
        col = lr[int(280 * s):int(400 * s), x] < 15
        best, start, run0 = 0, None, None
        for y in range(len(col) + 1):
            if y < len(col) and col[y]:
                run0 = y if run0 is None else run0
            else:
                if run0 is not None and y - run0 > best: best, start = y - run0, run0
                run0 = None
        if start is not None and best >= 6 * s:
            y0 = int(280 * s) + start
            m[y0 - int(8 * s):y0, x] = True
            BAND[y0:y0 + best, x] = True
    return m
regions = {
    'lip': lip(),
    'band': BAND,
    # W52: the whole underside strip under the door: black skirt, sill, lip, the dark gap and band (x 420-680, y 300-390)
    'underside': rect(420, 300, 680, 390),
    # W52: the black skirt panel on the car (PT luma 15-70 in x 480-680, y 265-345)
    'skirt': rect(480, 265, 680, 345) & (lr > 15) & (lr < 70),
    # W52: the red door's lower edge by the front wheel arch, where it turns under (x 425-475, y 340-375)
    'doorUnder': rect(425, 340, 475, 375),
    # W52: the door paint on the car (x 500-640, y 240-280, PT luma > 80): where W45's lobe filter helped
    'doorPaint': rect(500, 240, 640, 280) & (lr > 80),
    'wheel': rect(290, 410, 400, 500),        # W50: the front wheel reflected in the floor
    'doorRefl': rect(470, 395, 640, 445) & (lr > 60),  # W50: the red door reflected in the floor
    'car': rect(170, 380, 780, 520),          # W50: the whole floor reflection of the car
}
def hf(img, m):
    l = L(img); lap = np.abs(4 * l[1:-1, 1:-1] - l[:-2, 1:-1] - l[2:, 1:-1] - l[1:-1, :-2] - l[1:-1, 2:])
    return float(lap[m[1:-1, 1:-1]].mean())
out = {'_px': {k: int(v.sum()) for k, v in regions.items()}}
out['PT'] = {k: {'luma': round(float(lr[m].mean()), 1), 'std': round(float(lr[m].std()), 1), 'hf': round(hf(R, m), 2)} for k, m in regions.items()}
for a in argv[1:]:
    n, f = a.split('=', 1); X = load(f); lx = L(X)
    out[n] = {k: {'luma': round(float(lx[m].mean()), 1), 'std': round(float(lx[m].std()), 1), 'mad': round(float(np.abs(X - R)[m].mean()), 1), 'hf': round(hf(X, m), 2)} for k, m in regions.items()}
w = max(len(k) for k in out)
print('px', out['_px'])
print(f"{'luma / MAD':{w}}  " + ' '.join(f'{k:>12}' for k in regions) + '   wheel std/detail')
for n, r in out.items():
    if n == '_px': continue
    print(f'{n:{w}}  ' + ' '.join(f"{str(r[k]['luma']) + '/' + str(r[k].get('mad', '-')):>12}" for k in regions) + f"   {r['wheel']['std']}/{r['wheel']['hf']}")
if jout: json.dump(out, open(jout, 'w'), indent=1)
