# W55 (copy of W54): labelled crop grids. python3 -I crops.py <shotDir> <outJpg> <x0,y0,x1,y1> <scale> name[=label] ...
# Each tile is the same crop of <shotDir>/<name>.png, scaled by <scale>, labelled.
import sys
from PIL import Image, ImageDraw

shot_dir, out, box, scale = sys.argv[1], sys.argv[2], [int(v) for v in sys.argv[3].split(',')], float(sys.argv[4])
items = [a.split('=', 1) if '=' in a else (a, a) for a in sys.argv[5:]]
w, h = int((box[2] - box[0]) * scale), int((box[3] - box[1]) * scale)
cols = min(int(__import__("os").environ.get("COLS", 4)), len(items))
rows = (len(items) + cols - 1) // cols
g = Image.new('RGB', (cols * w + (cols - 1) * 4, rows * (h + 18) + (rows - 1) * 4), (255, 255, 255))
d = ImageDraw.Draw(g)
for i, (name, label) in enumerate(items):
    im = Image.open(f'{shot_dir}/{name}.png').convert('RGB').crop(box).resize((w, h), Image.LANCZOS)
    x, y = (i % cols) * (w + 4), (i // cols) * (h + 22)
    g.paste(im, (x, y + 18))
    d.text((x + 2, y + 3), label, fill=(0, 0, 0))
g.save(out, quality=90)
