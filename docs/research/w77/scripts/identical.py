# W74: compare the identity captures of two trees (identical.sh): max |diff| /255 of the final PNGs per scene.
# usage: python3 -I identical.py <dir> <tagA> <tagB>
import sys, glob, os
import numpy as np
from PIL import Image
d, a, b = sys.argv[1:4]
for fa in sorted(glob.glob(os.path.join(d, f'{a}-*.png'))):
    fb = fa.replace(f'/{a}-', f'/{b}-')
    if not os.path.exists(fb):
        continue
    x = np.asarray(Image.open(fa).convert('RGB')).astype(int)
    y = np.asarray(Image.open(fb).convert('RGB')).astype(int)
    diff = np.abs(x - y).max(2)
    print(os.path.basename(fa)[len(a) + 1:], 'max', diff.max(), '/255, px > 0:', int((diff > 0).sum()))
