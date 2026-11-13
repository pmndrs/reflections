# W76: X0 baseline at the new defaults vs W70's (pre-W76 defaults). usage: python3 -I compare.py <w70 baseline.json> <w76 baseline.json>
# Flicker first (the maintainer's priority: flicker > noise > colour > sharpness): rest drift, rest flicker, orbit std / d2;
# then 2x2, speckle, energy; showcase Measure (MAD vs PT per region); line spread. Flags beyond W70's noise floor
# (drift > 0.05 abs or 10 %, orbit std > 2 %; d2 / quad / speckle / energy > 5 % relative).
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
R = lambda o, r='reflection': (o or {}).get('regions', {}).get(r, {})
def flag(old, new, absf, relf):
    if old is None or new is None: return ''
    d = new - old
    if abs(d) <= absf and (old == 0 or abs(d) / abs(old) <= relf): return ''
    if abs(d) / max(abs(old), 1e-9) <= relf: return ''
    return ' **UP**' if d > 0 else ' (down)'
def f(x, n=3): return '-' if x is None else f'{x:.{n}f}'
print('## examples/ssr (reflection region; W70 -> W76)\n')
print('| scene | drift | rest flicker | drift AA off | drift upscale 1.5 | orbit std | orbit d2 | quad display / raw | pan d2 border | speckle % | energy loss |')
print('|---|---|---|---|---|---|---|---|---|---|---|')
for s in a['ssr']:
    x, y = a['ssr'][s], b['ssr'].get(s)
    if not y: continue
    dr = lambda o: R(o.get('restDrift')).get('mean')
    rows = [
        (dr(x), dr(y), 0.05, 0.10),
        ((x['restDrift'].get('rest') or {}).get('reflection', {}).get('mean'), (y['restDrift'].get('rest') or {}).get('reflection', {}).get('mean'), 0.05, 0.10),
        (R(x.get('restDriftAAOff')).get('mean'), R(y.get('restDriftAAOff')).get('mean'), 0.05, 0.10),
        (R(x.get('restDriftUpscale')).get('mean'), R(y.get('restDriftUpscale')).get('mean'), 0.05, 0.10),
        (R(x.get('orbitFlicker')).get('std'), R(y.get('orbitFlicker')).get('std'), 0.0, 0.02),
        (R(x.get('orbitFlicker')).get('d2'), R(y.get('orbitFlicker')).get('d2'), 0.0, 0.05),
    ]
    cells = [f'{f(o)} -> {f(n)}{flag(o, n, af, rf)}' for o, n, af, rf in rows]
    qd = lambda o, k: ((o.get('quadEnergy') or {}).get(k) or {}).get('reflection', {}).get('ratio')
    cells.append(f"{f(qd(x,'display'))} / {f(qd(x,'signal'))} -> {f(qd(y,'display'))} / {f(qd(y,'signal'))}")
    pan = lambda o: (o.get('edgePan') or {}).get('regions', {}).get('borderReflection', {}).get('d2')
    cells.append(f'{f(pan(x),2)} -> {f(pan(y),2)}{flag(pan(x), pan(y), 0, 0.05)}')
    sp = lambda o: R(o.get('speckle')).get('pct')
    cells.append(f'{f(sp(x))} -> {f(sp(y))}')
    en = lambda o: R(o.get('energy')).get('loss')
    cells.append(f'{f(en(x))} -> {f(en(y))}')
    print(f'| {s} | ' + ' | '.join(cells) + ' |')
print('\n## showcase (bench, ours denoised; W70 -> W76)\n')
print('| scene | glossy MAD dn / raw (+ RT) | drift | rest flicker | orbit std | orbit d2 | quad dn | speckle % (signal) | energy loss |')
print('|---|---|---|---|---|---|---|---|---|')
for s in a['showcase']:
    x, y = a['showcase'][s], b['showcase'].get(s)
    if not y: continue
    g = lambda o, m: next((r['methods'].get(m, {}).get('mad') for r in o['measure']['rows'] if r['region'] == 'glossy'), None)
    gq = lambda o: next((r['methods'].get('ours-denoised', {}).get('quad') for r in o['measure']['rows'] if r['region'] == 'glossy'), None)
    rt = g(y, 'ours-rt')
    cells = [f"{f(g(x,'ours-denoised'),2)} / {f(g(x,'ours-raw'),2)} -> {f(g(y,'ours-denoised'),2)} / {f(g(y,'ours-raw'),2)}" + (f' (RT {f(rt,2)})' if rt is not None else '')]
    for get, af, rf, n in [(lambda o: R(o.get('restDrift')).get('mean'), 0.05, 0.10, 3), (lambda o: (o['restDrift'].get('rest') or {}).get('reflection', {}).get('mean'), 0.05, 0.10, 3),
                           (lambda o: R(o.get('orbitFlicker')).get('std'), 0, 0.02, 3), (lambda o: R(o.get('orbitFlicker')).get('d2'), 0, 0.05, 2)]:
        cells.append(f'{f(get(x),n)} -> {f(get(y),n)}{flag(get(x), get(y), af, rf)}')
    cells.append(f'{f(gq(x))} -> {f(gq(y))}')
    sp = lambda o: R(o.get('speckle')).get('pct')
    cells.append(f'{f(sp(x))} -> {f(sp(y))}')
    en = lambda o: R(o.get('energy')).get('loss')
    cells.append(f'{f(en(x))} -> {f(en(y))}')
    print(f'| {s} | ' + ' | '.join(cells) + ' |')
    regs = [r for r in y['measure']['rows'] if r['region'] not in ('frame', 'glossy')]
    if regs:
        old = {r['region']: r for r in x['measure']['rows']}
        print('|  regions | ' + '; '.join(f"{r['region']} {f(old.get(r['region'],{}).get('methods',{}).get('ours-denoised',{}).get('mad'),1)} -> {f(r['methods'].get('ours-denoised',{}).get('mad'),1)}" + (f" (RT {f(r['methods'].get('ours-rt',{}).get('mad'),1)})" if 'ours-rt' in r['methods'] else '') for r in regs) + ' | | | | | | | |')
for key in ['lineSpread', 'lineSpreadAAOff', 'lineSpreadThin']:
    if key not in a or key not in b: continue
    print(f'\n## {key} (width ratio vs PT, peak; W70 -> W76)\n')
    for ra, rb in zip(a[key]['rows'], b[key]['rows']):
        m = lambda r, i: r['methods'].get(i) or {}
        print(f"- r {ra['roughness']}: " + '; '.join(f"{i.replace('ours-','')} x{m(ra,i).get('ratio')} (peak {m(ra,i).get('peakRatio')}) -> x{m(rb,i).get('ratio')} (peak {m(rb,i).get('peakRatio')})" for i in ['ours-denoised', 'ours-raw', 'ours-rt']))
if 'grazing' in a and 'grazing' in b:
    print('\n## grazing (MAD / gradient ratio; W70 -> W76)\n')
    for ra, rb in zip(a['grazing']['rows'], b['grazing']['rows']):
        m = lambda r, i: r['methods'].get(i) or {}
        print(f"- {ra['elevation']} deg: " + '; '.join(f"{i.replace('ours-','')} {m(ra,i).get('mad')} / x{m(ra,i).get('gradientRatio')} -> {m(rb,i).get('mad')} / x{m(rb,i).get('gradientRatio')}" for i in ['ours-denoised', 'ours-raw', 'ours-rt']))
