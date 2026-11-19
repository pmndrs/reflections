# W78: tables from the drive.mjs logs. usage: python3 -I summarise.py linespread|noise <log>
import json, sys

kind, path = sys.argv[1], sys.argv[2]
rows = []
for line in open(path):
    try:
        rows.append(json.loads(line))
    except ValueError:
        pass

def cell(m):
    if m is None:
        return '-'
    if m.get('w') is None:
        return f"lost ({100 * (m.get('peak') or 0):.0f} %)"
    return f"{m['w']:.2f} (x{m['ratio']:.2f}, {100 * (m.get('peak') or 0):.0f} %)"

if kind == 'linespread':
    for o in rows:
        if 'rows' not in o:
            continue
        for meth in sorted({k for r in o['rows'] for k in r['m']}):
            print(f"| {o['name']} | {meth} | " + ' | '.join(cell(r['m'].get(meth)) for r in o['rows']) + ' |')
elif kind == 'noise':
    for o in rows:
        if 'results' not in o:
            continue
        for x in o['results']:
            b = x['bins'][0]
            print(f"| {o['scene']} r {o.get('floor')} | {x['name']} | {'dn' if x['denoise'] else 'raw'} | std {b['std']:.3f} | flicker {b['flicker']:.3f} | bias {b['bias']:.3f} | signed {b['signed']:+.3f} | mean {b['mean']:.2f} |")
