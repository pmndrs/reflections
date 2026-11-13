# W74: MAD vs PT per region and config from measure.js output (jsonl). usage: python3 -I ms.py <file> ...
import json, sys
for f in sys.argv[1:]:
    print('==', f)
    for line in open(f):
        if not line.startswith('{'):
            continue
        d = json.loads(line)
        if 'name' not in d:
            continue
        print(f"{d['name']:<26}", '  '.join(f"{k} {v['ours-rt'][1]}" for k, v in d['rows'].items()))
