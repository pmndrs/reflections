# W106: the line-spread jsonl (linespread.js output lines) as a markdown table.
# Cell = width ratio vs the PT (peak share of the PT's peak in %), "lost" = peak < 10 % of the PT's.
# usage: python3 -I ls-table.py <file.jsonl>
import json, sys

rows = []
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith('{'):
        continue
    rows.append(json.loads(line))
if not rows:
    sys.exit('no rows')
methods = list(rows[0]['rows'][0]['m'].keys())
rs = [r['r'] for r in rows[0]['rows']]
print('| config | ' + ' | '.join(f'{m} r {r}' for m in methods for r in rs) + ' |')
print('|---|' + '---|' * (len(methods) * len(rs)))
for c in rows:
    cells = []
    for m in methods:
        for row in c['rows']:
            v = row['m'][m]
            pk = '' if v['peak'] is None else f" ({100 * v['peak']:.0f})"  # linespread.js stores peakRatio as `peak`
            cells.append('lost' + pk if v['lost'] else ('-' if v['ratio'] is None else f"x{v['ratio']:.2f}{pk}"))
    print(f"| {c['name']} | " + ' | '.join(cells) + ' |')
print()
print('PT width px: ' + ', '.join(f"r {row['r']} {row['pt']}" for row in rows[-1]['rows']))
