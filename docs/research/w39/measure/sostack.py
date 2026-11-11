# sostack.py prefix label out.jpg y0 h [scale]: rows off | on | traced reference | AO (crop y0..y0+h, full width)
import sys
from PIL import Image, ImageDraw, ImageFont
pre, label, out, y0, h = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
scale = float(sys.argv[6]) if len(sys.argv) > 6 else 0.8
rows = [('specular occlusion off', pre + '-final-so0.png'), ('specular occlusion on (GTAO -> Lagarde on the probe part)', pre + '-final-so1.png'),
        ('reference: every pixel traced (SSR + RT, threshold 1), raw, mean of 256 frames', pre.replace('-aaoff', '') + '-rtref.png'), ('AO input (GTAO on the G-buffer)', pre + '-ao.png')]
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 14)
ims = []
for l, p in rows:
    im = Image.open(p).convert('RGB').crop((0, y0, 960, y0 + h))
    ims.append((l, im.resize((int(960 * scale), int(h * scale)), Image.LANCZOS)))
w, hh = ims[0][1].size
sheet = Image.new('RGB', (w, 24 + len(ims) * (hh + 20)), (20, 20, 20)); d = ImageDraw.Draw(sheet)
d.text((4, 4), label, fill=(255, 220, 140), font=font)
for k, (l, im) in enumerate(ims):
    y = 24 + k * (hh + 20)
    d.text((4, y + 2), l, fill=(235, 235, 235), font=font); sheet.paste(im, (0, y + 20))
sheet.save(out, quality=80)
print(out, sheet.size)
