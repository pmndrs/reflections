# W71: max / mean |a - b| (RGB, /255) and differing px between PNGs: python3 imgdiff.py a.png b.png [...pairs]
import sys
import numpy as np
from PIL import Image
args = sys.argv[1:]
for a, b in zip(args[0::2], args[1::2]):
    A = np.asarray(Image.open(a).convert('RGB')).astype(np.int16)
    B = np.asarray(Image.open(b).convert('RGB')).astype(np.int16)
    d = np.abs(A - B)
    print(f'{a.split("/")[-1]} vs {b.split("/")[-1]}: max {d.max()}, mean {d.mean():.5f}, px differing {(d.max(axis=2) > 0).sum()}')
