import sys
from PIL import Image, ImageDraw
# crops.py out.jpg box(960 coords x0,y0,x1,y1) zoom label=file ... : side-by-side crops with labels
# (box scaled by each image's width / 960, then resized to the same size)
out, box, zoom = sys.argv[1], [int(v) for v in sys.argv[2].split(',')], float(sys.argv[3])
items = [a.split('=', 1) for a in sys.argv[4:]]
w, h = int((box[2] - box[0]) * zoom), int((box[3] - box[1]) * zoom)
pad = 18
M = Image.new('RGB', (w * len(items), h + pad), (20, 20, 20))
d = ImageDraw.Draw(M)
for i, (label, f) in enumerate(items):
    im = Image.open(f).convert('RGB'); s = im.width / 960
    c = im.crop(tuple(int(v * s) for v in box)).resize((w, h), Image.NEAREST if zoom / s >= 1 else Image.LANCZOS)
    M.paste(c, (i * w, pad))
    d.text((i * w + 4, 3), label, fill=(240, 240, 240))
M.save(out, quality=90)
