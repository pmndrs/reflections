"""W110: side-by-side crops (PT | off | on) of explore.js images, scaled up. python3 -I crops.py <dir> <tag-pose> x0 y0 x1 y1 [scale] [out]"""
import sys
from PIL import Image

d, stem, x0, y0, x1, y1 = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
scale = int(sys.argv[7]) if len(sys.argv) > 7 else 2
out = sys.argv[8] if len(sys.argv) > 8 else f'{d}/{stem}-crops.png'
ims = [Image.open(f'{d}/{stem}-{k}.png').convert('RGB').crop((x0, y0, x1, y1)) for k in ('pt', 'off', 'on')]
w, h = ims[0].size
sheet = Image.new('RGB', (w * 3 * scale + 8, h * scale), (255, 255, 255))
for i, im in enumerate(ims):
    sheet.paste(im.resize((w * scale, h * scale), Image.NEAREST), (i * (w * scale + 4), 0))
sheet.save(out)
print(out)
