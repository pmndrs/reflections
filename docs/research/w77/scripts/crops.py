"""W77: thinPost misses / final at maxCandidates 1 (left) and 8 (right), floor region around the post, 3x. python3 crops.py out/w77 docs/research/w77/thinpost.jpg"""
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
box = (380, 300, 620, 440)
rows = []
for view in ('misses', 'final'):
    ims = [Image.open(f'{src}/thinPost-{view}-mc{v}.png').convert('RGB').crop(box) for v in (1, 8)]
    w, h = ims[0].size
    row = Image.new('RGB', (2 * w + 6, h), (255, 255, 255))
    row.paste(ims[0], (0, 0)); row.paste(ims[1], (w + 6, 0))
    rows.append(row.resize((row.width * 3, row.height * 3), Image.NEAREST))
out = Image.new('RGB', (rows[0].width, sum(r.height for r in rows) + 6), (255, 255, 255))
y = 0
for r in rows:
    out.paste(r, (0, y)); y += r.height + 6
out.save(dst, quality=88)
