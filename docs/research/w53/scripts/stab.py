import sys, runpy, io, contextlib
import numpy as np
from PIL import Image
# stab.py <pt.png> <dir> <tag> name ... : per region, temporal std (still) and orbit flicker of 8-bit luma,
# from stability.js's PNGs (std x 8 in grey; orbit heat map at scale 32), plus the whole frame.
pt, d, tag = sys.argv[1:4]
names = sys.argv[4:]
sys.argv = ['metrics.py', pt]
with contextlib.redirect_stdout(io.StringIO()):
    g = runpy.run_path(__file__.replace('stab.py', 'metrics.py'))
regions = dict(g['regions'])
ld = lambda f: np.asarray(Image.open(f).convert('RGB'), np.float64)
print(f"{'':10}" + ''.join(f'{k:>20}' for k in list(regions) + ['frame']))
print(f"{'':10}" + ''.join(f"{'std / orbit':>20}" for _ in list(regions) + ['frame']))
for n in names:
    s = ld(f'{d}/{tag}-{n}-std.png')[..., 0] / 8
    o = ld(f'{d}/{tag}-{n}-orbit.png').sum(2) / 765 * 32
    row = [f'{s[m].mean():6.2f} / {o[m].mean():5.2f}' for m in regions.values()] + [f'{s.mean():6.2f} / {o.mean():5.2f}']
    print(f'{n:10}' + ''.join(f'{r:>20}' for r in row))
