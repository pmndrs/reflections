# W77: the 1080p timing table: per scene x ratio x preset, the mean of the two ABBA pages' medians (sum, and the
# reflection part = core passes + denoiser + upsample), plus each page's own performance - default delta (in-page A/B).
# usage: python3 -I timing-table.py <timing.jsonl>
import json, sys
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1]) if l.startswith('{')]
acc = defaultdict(list)
for r in rows:
    scene, up = r['tag'].split()
    for preset, ms in r['ms'].items():
        refl = ms.get('core total', 0) + ms.get('denoise total', 0) + ms.get('upsample', 0)
        acc[(scene, up, preset)].append((ms['sum'], refl, ms.get('three render', 0), ms.get('upscaler', 0)))
    d, p = r['ms']['default'], r['ms']['performance']
    acc[(scene, up, 'delta')].append((p['sum'] - d['sum'], 0, 0, 0))
mean = lambda xs: sum(xs) / len(xs)
print('| scene | ratio | full: sum (refl) | half+hits: sum (refl) | in-page delta per page | pages |')
print('|---|---|---|---|---|---|')
for scene in ['carConcept', 'chess', 'sponza', 'mirrorWall', 'contact']:
    for up, ratio in [('native', '1'), ('quality', '1.5'), ('performance', '2')]:
        f, h, dl = acc[(scene, up, 'default')], acc[(scene, up, 'performance')], acc[(scene, up, 'delta')]
        if not f: continue
        fs = f"{mean([x[0] for x in f]):.2f} ({mean([x[1] for x in f]):.2f})"
        hs = f"{mean([x[0] for x in h]):.2f} ({mean([x[1] for x in h]):.2f})"
        print(f"| {scene} | {ratio} | {fs} | {hs} | {', '.join(f'{x[0]:+.2f}' for x in dl)} | {len(f)} |")
