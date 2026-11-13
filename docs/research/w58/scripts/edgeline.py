# W58: the thin bright line in view=off along the skirt's lower edge / trim seams (bench shots, 1280x1280 w50).
# Line px = three's shading roughness view >= 0.9 (white) inside the crop; "beside" = px 2-3 rows above them that are not line px.
# python3 edgeline.py <shots dir> [names...]
import sys
import numpy as np
from PIL import Image

d = sys.argv[1]
names = sys.argv[2:] or ['off', 'off-key0', 'ibl', 'ibl-key0', 'probeSpecular', 'final', 'final-ss', 'pathtraced']
box = (680, 640, 1280, 880)


def img(n):
    return np.asarray(Image.open(f'{d}/{n}.png').convert('RGB'), np.float32)[box[1]:box[3], box[0]:box[2]]


def luma(a):
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


sr = img('shadingRoughness')[..., 0] / 255
line = sr >= 0.9
beside = np.zeros_like(line)
for k in (2, 3):
    beside[:-k] |= line[k:]
beside &= ~line & (sr > 0.05)
print(f'line px {line.sum()}, beside px {beside.sum()}; shading roughness line {sr[line].mean():.2f} beside {sr[beside].mean():.2f}')
for n in names:
    try:
        L = luma(img(n))
    except FileNotFoundError:
        continue
    print(f'{n:18} line {L[line].mean():6.1f}  beside {L[beside].mean():6.1f}')
