// W71: cross-build identity on the showcase (index.html?manual&scene=<s>&w=960&h=540&aa=off), settings absent.
// prelude: TAG, RT (bool). frameIndex 7, occupancy 0, history reset, 12 frames, shot.
P.stop();
await P.setSources({ rt: RT, denoise: true });
Object.assign(P.ssr.settings, { frameIndex: 7, minTraversalOccupancy: 0 });
P.ssr.resetHistory(); P.hybrid.resetHistory();
await P.step(12);
save(`${TAG}.png`, await P.shot());
return { errors: P.gpuErrors?.slice?.(0, 3) ?? [] };
