import sys, runpy, io, contextlib
import numpy as np
# classes.py <pt.png> <dir> <tag> : per region, the share of each hit source (per pixel-frame), the
# hit distance per source, and the linear signal (luminance) per source, from probe.js readbacks.
# Crop [280, 270, 660, 510] of the 960x540 frame.
pt, d, tag = sys.argv[1:4]
sys.argv = ['metrics.py', pt]
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(__file__.replace('classes.py', 'metrics.py'))
X0, Y0, X1, Y1 = 280, 270, 660, 510
cw, ch = X1 - X0, Y1 - Y0
A = np.fromfile(f'{d}/{tag}-a.f32', np.float32).reshape(ch, cw, 12)
B = np.fromfile(f'{d}/{tag}-b.f32', np.float32).reshape(ch, cw, 6)
lum = lambda c: 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]
names = ['SS', 'traced', 'tracedOnScreen', 'miss']
for region in ['skirtLip', 'halo', 'wheelRefl', 'doorRefl']:
    m = g['regions'][region][Y0:Y1, X0:X1]
    a, b = A[m], B[m]
    frac = a[:, 6:10]
    print(f'{region} ({m.sum()} px)')
    print('  share of pixel-frames:', {n: round(float(frac[:, i].mean()), 3) for i, n in enumerate(names)})
    # per pixel: dominant source and how stable it is over frames
    dom = frac.argmax(1); stab = frac.max(1)
    print('  dominant source share:', {n: round(float((dom == i).mean()), 3) for i, n in enumerate(names)}, ' mean stability (share of frames in the dominant source):', round(float(stab.mean()), 3))
    dist = {'SS': a[:, 10], 'traced': a[:, 11], 'tracedOnScreen': b[:, 0]}
    for i, n in enumerate(names[:3]):
        w = frac[:, i] > 0
        if w.sum() > 10:
            q = np.percentile(dist[n][w], [10, 50, 90])
            print(f'  hit distance {n}: p10/p50/p90 {q[0]:.3f} / {q[1]:.3f} / {q[2]:.3f} m  (px {int(w.sum())})')
    # frame 0: signal luminance per class
    cls = b[:, 4].astype(int); sl = lum(b[:, 1:4]); hd = b[:, 5]
    for i, n in zip([1, 2, 3, 0], names):
        w = cls == i
        if w.sum() > 10:
            print(f'  frame0 {n}: {int(w.sum())} px, signal lum mean {sl[w].mean():.4f} (p50 {np.median(sl[w]):.4f}), hit dist p50 {np.median(hd[w]):.3f}')
    print(f'  mean over frames: raw signal lum {lum(a[:, 0:3]).mean():.4f}   denoised lum {lum(a[:, 3:6]).mean():.4f}   ratio {lum(a[:, 3:6]).mean() / max(1e-6, lum(a[:, 0:3]).mean()):.3f}')
