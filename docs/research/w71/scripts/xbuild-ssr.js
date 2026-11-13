// W71: cross-build identity on examples/ssr (this branch vs main's 0abd154 served from out/w71-base).
// Page: /ssr/?manual&scene=<s>&rt=<0|1>&denoise=1&aa=off&hit=final&reshade=<reshade|off>
// prelude: TAG. Settings absent (the package defaults), frameIndex 7, occupancy 0, history reset, 8 frames, shot.
P.stop();
P.setSettings({ frameIndex: 7, minTraversalOccupancy: 0 });
P.ssr.resetHistory(); P.hybrid.resetHistory(); P.aa?.reset?.();
await P.step(8);
save(`${TAG}.png`, await P.shot());
return { errors: P.gpuErrors?.slice?.(0, 3) ?? [] };
