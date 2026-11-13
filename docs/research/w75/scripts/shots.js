// W75: final shots per scene on the ssr page (ssr/?manual&aa=off[&res=half][&denoise=0][&rt=1]), fixed frameIndex.
// prelude: TAG, SCENES, optional FRAMES (default 24), VIEWS (default ['final'])
const S = await (async () => { for (let i = 0; i < 600 && !window.__p.ssr; i++) await new Promise((r) => setTimeout(r, 500)); return window.__p; })();
const frames = typeof FRAMES !== 'undefined' ? FRAMES : 24;
const views = typeof VIEWS !== 'undefined' ? VIEWS : ['final'];
for (const id of SCENES) {
  await S.load(id);
  for (const v of views) {
    if (S.setView) S.setView(v);
    S.ssr.resetHistory(); S.hybrid.resetHistory();
    await S.step(frames);
    save(`${TAG}-${id}-${v}.png`, await S.shot());
  }
}
return { errors: (typeof S.gpuErrors === 'function' ? S.gpuErrors() : S.gpuErrors ?? []).slice(0, 3), res: S.ssr.resolution };
