# W77: tables from the jsonl logs. usage: python3 -I summarise.py bench|ssr|lines|timing <file.jsonl> [method]
import json, sys

kind, path = sys.argv[1], sys.argv[2]
rows = [json.loads(l) for l in open(path) if l.startswith('{')]

if kind == 'bench':
    method = sys.argv[3] if len(sys.argv) > 3 else 'ours-rt'
    for r in rows:
        if r.get('discard'): continue
        m, f = r['measure'], r['flicker']
        regs = [k for k in ['frame', 'glossy', 'lip', 'band', 'door', 'car', 'wheel'] if k in m]
        mad = ' '.join(f"{k} {m[k][method]['mad']:.1f}" for k in regs)
        fl = ' '.join(f"{k} {f[k]['orbitStd']:.2f}/{f[k]['drift']:.2f}" for k in ['reflection', 'lip', 'band'] if k in f)
        print(f"{r['scene']:10} {r['cell']:24} MAD[{method}] {mad} | orbit/drift {fl} | restFl {r['restFlicker']}")
elif kind == 'ssr':
    for r in rows:
        print(f"{r['tag']:24} {r['preset']:12} cone {r['cone']} tracer {r['tracer']} orbit {r['orbitStd']} d2 {r['orbitD2']} drift {r['drift']} restFl {r['restFlicker']} ({r['restPct']}%)")
elif kind == 'lines':
    for r in rows:
        if r.get('discard'): continue
        for x in r['rows']:
            ms = ' | '.join(f"{k} {v['width']} x{v['ratio']} peak {v['peak']}{' LOST' if v['lost'] else ''}" for k, v in x.items() if isinstance(v, dict))
            print(f"{r['cell']:16} r {x['r']:.2f} PT {x['pt']} | {ms}")
elif kind == 'timing':
    for r in rows:
        for n, ms in r['ms'].items():
            print(f"{r['tag']:24} {n:12} sum {ms.get('sum', 0):6.2f} three {ms.get('three render', 0):5.2f} core {ms.get('core total', 0):5.2f} dn {ms.get('denoise total', 0):5.2f} up {ms.get('upsample', 0):4.2f} aa {ms.get('upscaler', 0):4.2f} cone {r['cone'].get(n)}")
