# W105: merge `pnpm check -- --only flicker` JSONs (out/flicker-<label>.json) into one table per scene x region,
# each config's metrics with the % change against the baseline config (default 'off').
#   python3 -I flicker-table.py [--base off] a.json b.json ...
# A run label is appended to the config when the same config appears in several files (off@a, off@b).
import json
import sys

args = sys.argv[1:]
base = 'off'
if args and args[0] == '--base':
    base, args = args[1], args[2:]
rows = {}  # (scene, region) -> [(config, run, values)]
for f in args:
    d = json.load(open(f))
    run = d['label']
    for r in d['results']:
        for reg, v in (r.get('regions') or {}).items():
            if reg.startswith('_'):
                continue
            v = dict(v, pan=r['regions'].get('_pan'))
            rows.setdefault((r['scene'], reg), []).append((r['config'], run, v))
keys = ['px', 'drift', 'rest', 'orbitStd', 'd2', 'quad', 'quadRaw', 'speckle', 'pan']
for (scene, reg), lst in rows.items():
    bases = [v for c, _, v in lst if c == base]
    print(f'\n### {scene} / {reg}\n')
    print('| config | run | ' + ' | '.join(keys) + ' |')
    print('|' + '---|' * (len(keys) + 2))
    for c, run, v in lst:
        cells = []
        for k in keys:
            x = v.get(k)
            if x is None:
                cells.append('-')
                continue
            b = [bv.get(k) for bv in bases if bv.get(k)]
            if c != base and b and k not in ('px',):
                m = sum(b) / len(b)
                cells.append(f'{x} ({(x - m) / m * 100:+.0f}%)' if m else f'{x}')
            else:
                cells.append(f'{x}')
        print(f'| {c} | {run} | ' + ' | '.join(cells) + ' |')
