// W106: a side-by-side shot of the bench (left | right from the URL) after the methods settle. Prelude: TAG, optional FRAMES.
P.setMode('side');
for (let i = 0; i < 300; i++) { const p = P.pending(); if (!p.methods.length && !p.page) break; await new Promise((r) => setTimeout(r, 200)); }
await P.step(typeof FRAMES !== 'undefined' ? FRAMES : 64);
save('w106-ls-' + TAG + '.png', await P.shot());
return P.info().status;
