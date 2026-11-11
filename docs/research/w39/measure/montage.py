# montage.py out.jpg cols scale "label1=path1" "label2=path2" ... [--crop x,y,w,h]
import sys
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
crop = None
if '--crop' in args:
    i = args.index('--crop'); crop = tuple(int(v) for v in args[i + 1].split(',')); del args[i:i + 2]
out, cols, scale = args[0], int(args[1]), float(args[2])
items = [a.split('=', 1) for a in args[3:]]
ims = []
for label, p in items:
    im = Image.open(p).convert('RGB')
    if crop: im = im.crop((crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    ims.append((label, im))
w, h = ims[0][1].size
rows = (len(ims) + cols - 1) // cols
sheet = Image.new('RGB', (cols * w + (cols - 1) * 4, rows * (h + 22) - 0), (20, 20, 20))
d = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 15)
except Exception:
    font = ImageFont.load_default()
for k, (label, im) in enumerate(ims):
    x, y = (k % cols) * (w + 4), (k // cols) * (h + 22)
    d.text((x + 4, y + 3), label, fill=(235, 235, 235), font=font)
    sheet.paste(im, (x, y + 22))
sheet.save(out, quality=82)
print(out, sheet.size)
