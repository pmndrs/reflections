# W52 crop sheets in the style of W50's door-skirt-halo.jpg.
# python3 crops.py <shots dir> <tag> <out.jpg> <x0,y0,x1,y1 in 960x540 coords> <panel width> name=label ...
# Each panel: the 16-frame mean shot `<tag>-<name>-mean.png` (`<tag>-pathtraced.png` for name 'pathtraced'),
# cropped and scaled to the panel width, labelled top-left; three panels per row.
import sys
from PIL import Image, ImageDraw
d, tag, out, box, pw = sys.argv[1:6]
x0, y0, x1, y1 = map(int, box.split(','))
pw = int(pw)
items = [a.split('=', 1) for a in sys.argv[6:]]
panels = []
for name, label in items:
    f = f'{d}/{tag}-pathtraced.png' if name == 'pathtraced' else f'{d}/{tag}-{name}-mean.png'
    im = Image.open(f).convert('RGB'); s = im.width / 960
    c = im.crop((int(x0 * s), int(y0 * s), int(x1 * s), int(y1 * s)))
    ph = round(pw * (y1 - y0) / (x1 - x0))
    c = c.resize((pw, ph), Image.LANCZOS)
    g = ImageDraw.Draw(c); g.rectangle([0, 0, pw, 14], fill=(0, 0, 0)); g.text((4, 1), label, fill=(255, 255, 255))
    panels.append(c)
cols = 3; rows = (len(panels) + cols - 1) // cols
ph = panels[0].height
sheet = Image.new('RGB', (cols * pw, rows * ph), (0, 0, 0))
for i, p in enumerate(panels): sheet.paste(p, ((i % cols) * pw, (i // cols) * ph))
sheet.save(out, quality=88)
