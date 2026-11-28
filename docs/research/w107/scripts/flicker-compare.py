# W107: compare flicker JSONs (scripts/flicker.mjs output) per scene / region / metric between two configs, pooling
# every file given (A/B runs in both orders). Prints mean A, mean B and B / A - 1 per metric, and the A-vs-A spread
# (the repeat columns drift2 / orbitStd2 and the across-file spread) as the noise floor.
# python3 flicker-compare.py <configA> <configB> file1.json file2.json ...
import json, sys, statistics as st

a_name, b_name, files = sys.argv[1], sys.argv[2], sys.argv[3:]
METRICS = ['drift', 'rest', 'orbitStd', 'd2', 'quad', 'quadRaw', 'speckle']
vals = {}  # (scene, region, metric, config) -> [values]
for f in files:
    for r in json.load(open(f))['results']:
        for reg, v in (r.get('regions') or {}).items():
            if reg.startswith('_'):
                vals.setdefault((r['scene'], 'pan', 'd2', r['config']), []).append(v)
                continue
            for m in METRICS:
                if v.get(m) is not None:
                    vals.setdefault((r['scene'], reg, m, r['config']), []).append(v[m])
            if v.get('drift2') is not None: vals.setdefault((r['scene'], reg, 'drift', r['config']), []).append(v['drift2'])
            if v.get('orbitStd2') is not None: vals.setdefault((r['scene'], reg, 'orbitStd', r['config']), []).append(v['orbitStd2'])
keys = sorted({k[:3] for k in vals})
print(f"| scene | region | metric | {a_name} | {b_name} | change | {a_name} spread |")
print("|---|---|---|---|---|---|---|")
for s, reg, m in keys:
    A, B = vals.get((s, reg, m, a_name)), vals.get((s, reg, m, b_name))
    if not A or not B: continue
    ma, mb = st.mean(A), st.mean(B)
    ch = (mb / ma - 1) * 100 if ma else float('nan')
    spread = (max(A) - min(A)) / ma * 100 if ma else float('nan')
    flag = ' **' if ma and abs(ch) > max(3, spread) and abs(mb - ma) > 0.002 else ''
    print(f"| {s} | {reg} | {m} | {ma:.4f} | {mb:.4f} | {ch:+.1f} %{flag} | {spread:.1f} % |")
