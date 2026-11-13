# W74: one line per (config, denoiser) from metrics.js output (jsonl): quad ratio (display / raw signal) and orbit std / d2 per region.
# usage: python3 -I summary.py <file.jsonl> [region ...]
import json, sys
regions = sys.argv[2:] or ['reflection']
for line in open(sys.argv[1]):
    if not line.startswith('{'):
        continue
    d = json.loads(line)
    if 'name' not in d:
        continue
    parts = [f"{d['name']:<14} {'dn ' if d['denoise'] else 'raw'}"]
    for r in regions:
        q = d.get('quadEnergy') or {}
        disp = (q.get('display') or {}).get(r, {})
        sig = (q.get('signal') or {}).get(r, {})
        o = (d.get('orbitFlicker') or {}).get(r, {})
        parts.append(f"{r}: quad {disp.get('ratio')} / sig {sig.get('ratio')} | orbit std {o.get('std')} d2 {o.get('d2')}")
    print('  '.join(parts))
