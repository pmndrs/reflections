// W110: showcase shots at views / cameras, per debug view (drive.mjs on /showcase/?scene=sponza&rt=1&manual&w=960&h=540
// [&rtAlpha=0]). Prelude: CAMS = [[name, pose | [pos, target]]], VIEWS = ['final', 'source', 'hitRadiance'], TAG = 'on', FRAMES = 32
const cams = typeof CAMS !== 'undefined' ? CAMS : [['low', 'low']];
const views = typeof VIEWS !== 'undefined' ? VIEWS : ['final', 'source', 'hitRadiance'];
const tag = typeof TAG !== 'undefined' ? TAG : 'on';
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 32;
P.stop();
for (const [name, cam] of cams) {
  if (typeof cam === 'string') P.setPose(cam); else P.setCamera(cam[0], cam[1]);
  for (const v of views) {
    P.setView(v);
    await P.step(frames);
    save(`${name}-${v}-${tag}.png`, await P.shot());
  }
}
return { errors: P.gpuErrors?.slice?.(0, 3) ?? null };
