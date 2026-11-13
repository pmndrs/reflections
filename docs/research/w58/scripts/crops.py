# W58: crop sheets. python3 crops.py <scratch dir> <out dir>
import sys
from PIL import Image, ImageDraw

src, out = sys.argv[1:3]


def sheet(paths, labels, box, scale, cols, name):
    tiles = [Image.open(f'{src}/{p}').convert('RGB').crop(box) for p in paths]
    tiles = [t.resize((t.width * scale, t.height * scale), Image.NEAREST) for t in tiles]
    w, h = tiles[0].size
    rows = (len(tiles) + cols - 1) // cols
    s = Image.new('RGB', (w * cols, h * rows))
    d = ImageDraw.Draw(s)
    for i, (t, lab) in enumerate(zip(tiles, labels)):
        x, y = (i % cols) * w, (i // cols) * h
        s.paste(t, (x, y))
        d.rectangle((x, y, x + 7 * len(lab) + 6, y + 13), fill=(0, 0, 0))
        d.text((x + 3, y + 1), lab, fill=(255, 255, 0))
    s.save(f'{out}/{name}', quality=92)


# 960x540, AA off: the lip / band edge, x 470-630, y 300-380 at 4x
sheet(['shots/pathtraced.png', 'shots/final.png', 'shots/final-ss.png', 'shots/final-spq4.png',
       'shots/rtSource.png', 'shots/rtSource-ss.png', 'shots/den.png', 'shots/den-ss.png'],
      ['path traced', 'raw, quadCopy always (default)', 'raw, quadCopy sameSurface', 'raw, spq 4',
       'rtSource, always', 'rtSource, sameSurface', 'denoised, always', 'denoised, sameSurface'],
      (470, 300, 630, 380), 4, 2, 'edge-960.jpg')
# 1280x1280 main page, AA off, denoiser off: view=off with the clear coat and without, at 3x
sheet(['coat/coat-off.png', 'coat/nocoat-off.png', 's1280/shadingRoughness.png', 's1280/off-key0.png',
       'coat/coat-final.png', 'coat/nocoat-final.png', 's1280/final-ss.png', 's1280/pathtraced.png'],
      ['view=off', 'view=off, clear coat 0', "three's shading roughness", 'view=off, keyLight 0',
       'final raw', 'final raw, clear coat 0', 'final raw, sameSurface', 'path traced'],
      (760, 770, 960, 850), 3, 2, 'offline-1280.jpg')
