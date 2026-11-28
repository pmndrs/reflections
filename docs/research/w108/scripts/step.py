# W108 (D3701): how much of carConcept's front tyre the wheel probe covers, and how sharp the edge where it stops is.
# python3 -I step.py <shotDir>   (shots.js output: probes-off / probes-world / probes-oriented at w50, 1280 x 1280)
# Tyre pixels: the dark rubber in the front tyre's far half (ROI below; luminance < 70 in probes-off). Covered: the wheel
# probe moved the pixel (|L(config) - L(off)| > 2). The step: the mean |horizontal gradient| of L(config) - L(off) over tyre
# pixels (a covered pixel next to an uncovered one makes a large one), and the share of tyre pixels left uncovered.
import sys
import numpy as np
from PIL import Image

d = sys.argv[1]
roi = (440, 700, 540, 900)  # x0, y0, x1, y1: the front tyre's far edge at the arch (front-tyre.jpg)
L = lambda n: np.asarray(Image.open(f'{d}/{n}.png').convert('L')).astype(float)[roi[1]:roi[3], roi[0]:roi[2]]
off = L('probes-off')
tyre = off < 70
for name in ['probes-world', 'probes-oriented']:
    diff = L(name) - off
    covered = np.abs(diff) > 2
    gx = np.abs(np.diff(diff, axis=1))
    m = tyre[:, 1:] & tyre[:, :-1]
    print(f'{name}: tyre px {tyre.sum()}, covered {covered[tyre].mean() * 100:.1f} %, uncovered {(~covered[tyre]).mean() * 100:.1f} %, '
          f'mean |d/dx (config - off)| {gx[m].mean():.2f}, p99 {np.percentile(gx[m], 99):.1f}')
