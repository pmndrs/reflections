import sys, runpy, io, contextlib
import numpy as np
from PIL import Image
# classify2.py <shots dir> <region> : region px by rtSource class (reshade vs off), final luma per class, denoised and raw
d, region = sys.argv[1], sys.argv[2]
sys.argv = ['metrics.py', f'{d}/now-960-pathtraced.png']
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(__file__.replace('classify2.py', 'metrics.py'))
m = g['regions'][region]; L = g['L']; lr = g['lr']
cols = {'rtHit': (0x33, 0x66, 0xff), 'rtScreen': (0x33, 0xe6, 0xf2), 'rtMiss': (0xf2, 0x33, 0xd9), 'budget': (0xff, 0x8c, 0x1a), 'ssrHit': (0x26, 0xd9, 0x40), 'probe': (0xd9, 0x99, 0x26)}
names = list(cols); C = np.array([cols[n] for n in names], float); Cn = C / C.max(1, keepdims=True)
for tag in ['reshade', 'off']:
    s = np.asarray(Image.open(f'{d}/nowv-{tag}-rtSource.png').convert('RGB'), float)[m]
    idx = ((s / np.maximum(s.max(1, keepdims=True), 1))[:, None, :] - Cn[None]) ** 2
    idx = idx.sum(2).argmin(1)
    print(tag, {n: round(float((idx == i).mean()), 3) for i, n in enumerate(names) if (idx == i).any()})
    for pre in ['nowv', 'nowraw']:
        lf = L(np.asarray(Image.open(f'{d}/{pre}-{tag}-final.png').convert('RGB'), float))[m]
        print('   ', pre, {n: (round(float(lf[idx == i].mean()), 1), round(float(lr[m][idx == i].mean()), 1)) for i, n in enumerate(names) if (idx == i).sum() > 30}, '(ours, PT)')
