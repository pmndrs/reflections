# W71 phase 2: summarise the JSON log lines. python3 summarise.py <kind> <log>...
import json, sys
kind, files = sys.argv[1], sys.argv[2:]
def rows(f):
    for l in open(f):
        if l.startswith('{'): yield json.loads(l)
        elif 'ERROR' in l or 'exception' in l: print('  !!', l.strip()[:300])
def reg(d, prefer=('reflection', 'glossy')):
    for p in prefer:
        if p in d: return p
    return [k for k in d if k != 'whole'][0]
for f in files:
    print(f.split('/')[-1])
    for d in rows(f):
        c = d.get('config')
        if kind == 'page':
            parts = []
            if 'restDrift' in d:
                r = d['restDrift']; R = reg(r['regions'])
                parts.append(f"[{R}] drift {r['regions'][R]['mean']:.3f} >8 {r['regions'][R]['pctOver']:.3f} rest {r['rest'][R]['mean']:.3f}")
            if 'orbitFlicker' in d:
                o = d['orbitFlicker']['regions']; R = reg(o)
                parts.append(f"orbit std {o[R]['std']:.3f} d2 {o[R]['d2']:.3f}")
            if 'quadEnergy' in d:
                q = d['quadEnergy']; R = reg(q['display'])
                sig = q.get('signal') or {}
                parts.append(f"quad disp {q['display'][R]['ratio']:.4f} sig {sig.get(R, {}).get('ratio', '-')}")
            if 'edgePan' in d:
                e = d['edgePan']['regions']
                parts.append(f"pan borderRefl d2 {e['borderReflection']['d2']:.3f} >4 {e['borderReflection']['pctD2Over']:.3f} | centreRefl d2 {e['centreReflection']['d2']:.3f}")
            if 'stats' in d:
                s = d['stats']; w = s.get('wall') or {}
                parts.append(f"rays {s['rays']} misses {s['misses']} streak {w.get('streakFraction')} wallConf {w.get('confidentFraction')} objects {json.dumps(s.get('objects'))[:300]}")
            if 'trace' in d: parts.append(f"traced {d['trace'].get('traced')}")
            print(f"  {c:10s} " + ' | '.join(parts))
        elif kind == 'measure':
            print(f"  {c:20s} " + '  '.join(f"{r} " + ' '.join(f"{m}:{v[m]['mad']}/q{v[m].get('quad')}/s{v[m].get('std')}" for m in v if isinstance(v[m], dict)) for r, v in d['rows'].items()))
        elif kind == 'line':
            for row in d['lineSpread']['rows']:
                ms = ' '.join(f"{m}: w {v['width']} x{v['ratio']} peak {v.get('peak')}" for m, v in row['methods'].items())
                print(f"  {c:10s} r {row['roughness']} PT {row['pt']} (peak {row.get('ptPeak')}) | {ms}")
        elif kind == 'graz':
            for row in d['grazing']['rows']:
                ms = ' '.join(f"{m}: mad {v['mad']} bias {v['bias']} grad x{v['gradientRatio']}" for m, v in row['methods'].items())
                print(f"  {c:10s} {row['elevation']:2d} deg | {ms}")
        elif kind == 'time':
            for cfg, ms in d['ms'].items():
                print(f"  {cfg:10s} " + ' '.join(f"{k} {v}" for k, v in ms.items()))
        else:
            print(' ', json.dumps(d)[:400])
