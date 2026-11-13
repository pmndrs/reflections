# W77: the 1080p timing table. The GPU was shared with other agents' headless Chromes, so the same cell varies up to
# 2.3x between pages; per scene x ratio x preset this takes the least-contended page (min over pages of the page's
# median), for the frame sum and for the reflection part (core passes + denoiser + upsample), and lists each page's
# in-page delta (performance - default, alternating rounds inside the page).
# usage: python3 -I timing-table.py <timing.jsonl> ...
import json, sys
from collections import defaultdict

rows = [json.loads(l) for p in sys.argv[1:] for l in open(p) if l.startswith('{')]
acc = defaultdict(list)
for r in rows:
    scene, up = r['tag'].split()
    for preset, ms in r['ms'].items():
        refl = ms.get('core total', 0) + ms.get('denoise total', 0) + ms.get('upsample', 0)
        acc[(scene, up, preset)].append((ms['sum'], refl))
    acc[(scene, up, 'delta')].append(r['ms']['performance']['sum'] - r['ms']['default']['sum'])
med = lambda xs: sorted(xs)[len(xs) // 2]
print('| scene | ratio | full: frame (reflections) | half+hits: frame (reflections) | in-page frame delta, median (pages) |')
print('|---|---|---|---|---|')
for scene in ['carConcept', 'chess', 'sponza', 'mirrorWall', 'contact']:
    for up, ratio in [('native', '1'), ('quality', '1.5'), ('performance', '2')]:
        f, h, dl = acc[(scene, up, 'default')], acc[(scene, up, 'performance')], acc[(scene, up, 'delta')]
        if not f: continue
        cell = lambda x: f"{min(a for a, _ in x):.1f} ({min(b for _, b in x):.2f})"
        print(f"| {scene} | {ratio} | {cell(f)} | {cell(h)} | {med(dl):+.2f} ({', '.join(f'{d:+.1f}' for d in dl)}) |")
