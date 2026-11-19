# W76: summaries of the drive logs. usage: python3 -I summary.py <grazing|line> <log or jsonl>...
import json, sys
kind = sys.argv[1]
for f in sys.argv[2:]:
    for l in open(f):
        if not l.startswith('{"name'):
            continue
        o = json.loads(l)
        print(o['name'])
        for r in o['rows']:
            if kind == 'grazing':
                print('  e%2d ' % r['e'] + ' | '.join('%s MAD %.2f grad x%.3f' % (k.replace('ours-', ''), v[0], v[2]) for k, v in r['m'].items()))
            else:
                print('  r %.2f PT %s px: ' % (r['r'], r['pt']) + ' | '.join('%s x%s peak %s%s' % (k.replace('ours-', ''), v['ratio'], v['peak'], ' LOST' if v.get('lost') else '') for k, v in r['m'].items()))
