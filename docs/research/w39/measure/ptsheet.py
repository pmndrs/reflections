# ptsheet.py tag label out.jpg x,y,w,h scale: off | on | path traced | AO (2 x 2)
import sys
from PIL import Image, ImageDraw, ImageFont
tag, label, out = sys.argv[1], sys.argv[2], sys.argv[3]
x, y, w, h = (int(v) for v in sys.argv[4].split(','))
scale = float(sys.argv[5])
rows = [('specular occlusion off (compare.html, ours denoised)', 'ours-so0'), ('specular occlusion on (GTAO -> Lagarde, probe part)', 'ours-so1'),
        ('path traced, 64 spp + OIDN (reference)', 'ref'), ('AO input (GTAO, showcase page)', 'ao')]
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 14)
ims = []
for l, k in rows:
    im = Image.open(f'task3/pt-{tag}-{k}.png').convert('RGB').crop((x, y, x + w, y + h))
    ims.append((l, im.resize((int(w * scale), int(h * scale)), Image.LANCZOS)))
W, H = ims[0][1].size
sheet = Image.new('RGB', (2 * W + 4, 24 + 2 * (H + 20)), (20, 20, 20)); d = ImageDraw.Draw(sheet)
d.text((4, 4), label, fill=(255, 220, 140), font=font)
for k, (l, im) in enumerate(ims):
    px, py = (k % 2) * (W + 4), 24 + (k // 2) * (H + 20)
    d.text((px + 4, py + 2), l, fill=(235, 235, 235), font=font); sheet.paste(im, (px, py + 20))
sheet.save(out, quality=80)
print(out, sheet.size)
