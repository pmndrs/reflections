# W106: the flicker section's JSON (scripts/flicker.mjs, out/flicker-<label>.json) as one table per scene:
# the reflection region (or the first region), every metric, one row per config. Several files may be given.
# usage: python3 -I flicker-table.py <flicker-a.json> [<flicker-b.json> ...]
import json, sys

res = []
for f in sys.argv[1:]:
    res += json.load(open(f))['results']
scenes = []
for x in res:
    if x['scene'] not in scenes:
        scenes.append(x['scene'])
cols = ['drift', 'pct8', 'rest', 'orbitStd', 'd2', 'quad', 'quadRaw', 'speckle']
print('| scene | config | region | ' + ' | '.join(cols) + ' | pan d2 |')
print('|---|---|---|' + '---|' * (len(cols) + 1))
for s in scenes:
    for x in res:
        if x['scene'] != s or not x.get('regions'):
            continue
        regs = x['regions']
        rn = 'reflection' if 'reflection' in regs else 'glossy' if 'glossy' in regs else [k for k in regs if not k.startswith('_')][0]
        v = regs[rn]
        cells = []
        for c in cols:
            a = v.get(c)
            b = v.get(c + '2')
            cells.append(f'{a}' + (f' / {b}' if b is not None else ''))
        print(f"| {s} | {x['config']} | {rn} | " + ' | '.join(cells) + f" | {regs.get('_pan')} |")
