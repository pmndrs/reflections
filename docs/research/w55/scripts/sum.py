# W55: one line per Measure row (drive.mjs output of measure.js): region (PT luma) method: luma / MAD.
# python3 -I sum.py <drive output> ...
import json, sys

REGIONS = ['frame', 'glossy', 'hub', 'wheelFace', 'cabin', 'floorWheel', 'lip', 'band', 'wheel', 'door', 'car']
for f in sys.argv[1:]:
    for line in open(f):
        if not line.startswith('{'):
            continue
        d = json.loads(line)
        r = d['rows']
        cells = []
        for k in REGIONS:
            if k not in r:
                continue
            v = r[k]
            ms = [f"{m[:2]}:{v[m][0]}/{v[m][1]}" for m in v if m not in ('px', 'pt')]
            cells.append(f"{k}({v['pt']}) " + ' '.join(ms))
        print(d['name'].ljust(24), ' | '.join(cells))
