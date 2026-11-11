import sys, numpy as np
from PIL import Image
tag = sys.argv[1]
L = lambda p: np.array(Image.open(f'task3/pt-{tag}-{p}.png').convert('RGB')).astype(float)
ref, a, b, ao, sc = L('ref'), L('ours-so0'), L('ours-so1'), L('ao')[..., 0], L('showcase')
print(tag, 'alignment: showcase page vs compare ours (so off) MAD %.2f' % np.abs(sc - a).mean())
for name, m in [('geometry', ao > 1), ('ao<0.95', (ao > 1) & (ao < 0.95 * 255)), ('ao<0.8', (ao > 1) & (ao < 0.8 * 255)), ('ao<0.6', (ao > 1) & (ao < 0.6 * 255))]:
    da, db = (a - ref).mean(2)[m], (b - ref).mean(2)[m]
    print(f'  {name:9s} px {m.sum():6d} | off MAD {np.abs(a - ref).mean(2)[m].mean():6.2f} signed {da.mean():6.2f} | on MAD {np.abs(b - ref).mean(2)[m].mean():6.2f} signed {db.mean():6.2f}')
