# W77: luma MAD / % px > 8 of each ssr-page frame vs the scene's 'full x1' (default preset, native) frame.
# usage: python3 -I framediff.py <dir with <scene>-<upscale>-<preset>.png>
import os, sys
import numpy as np
from PIL import Image

d = sys.argv[1]
load = lambda f: np.asarray(Image.open(os.path.join(d, f)).convert('L'), dtype=np.float32)
for scene in ['mirrorWall', 'contact']:
    ref = load(f'{scene}-native-default.png')
    for up in ['native', 'quality', 'performance']:
        for preset in ['default', 'performance']:
            a = load(f'{scene}-{up}-{preset}.png')
            diff = np.abs(a - ref)
            print(f'{scene:10} {up:11} {preset:11} MAD {diff.mean():.2f} over8 {100 * (diff > 8).mean():.2f}%')
