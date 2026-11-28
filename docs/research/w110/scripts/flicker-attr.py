"""W110: per scene / region / metric, each config's change from 'base' in one flicker JSON (rows with any |change| > 3 %).
python3 -I flicker-attr.py file.json [configs...]"""
import json, sys

f, *configs = sys.argv[1:]
configs = configs or ['emOff', 'rmOff', 'on']
M = ['drift', 'orbitStd', 'd2', 'quad', 'rest']
v = {}
for r in json.load(open(f))['results']:
    for reg, x in (r.get('regions') or {}).items():
        if reg.startswith('_'):
            continue
        for m in M:
            v[(r['scene'], reg, m, r['config'])] = x.get(m)
for s in sorted({k[:3] for k in v}):
    b = v.get(s + ('base',))
    if not b:
        continue
    pct = {c: (v[s + (c,)] / b - 1) * 100 for c in configs if v.get(s + (c,)) is not None}
    if pct and max(abs(x) for x in pct.values()) > 3:
        print(' | '.join(s), '| base', round(b, 4), '|', '  '.join(f'{c} {p:+.1f}%' for c, p in pct.items()))
