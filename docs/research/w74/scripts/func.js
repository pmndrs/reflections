// W74: tracedMissRate full vs half on the ssr page (ssr/?manual&rt=1[&w=&h=]): trace stats, shots of final and source.
// prelude: optional SCENES, FILL (extra trace settings for 'half'), NO_SHOTS
const scenes = typeof SCENES !== 'undefined' ? SCENES : ['offscreen', 'moving', 'contact', 'mirrorWall', 'facingMirrors'];
const out = [];
for (const id of scenes) {
  await P.load(id);
  for (const rate of ['full', 'half']) {
    P.setTraceSettings({ tracedMissRate: rate, ...(rate === 'half' && typeof FILL !== 'undefined' ? FILL : {}) });
    P.hybrid.resetHistory(); P.ssr.resetHistory();
    await P.step(6);
    const st = await P.traceStats();
    out.push({ id, rate, misses: st.misses, traced: st.traced, skipped: st.halfRateSkipped, filled: st.filled, fallbacks: st.fillFallbacks, overflow: st.fillOverflow });
    if (typeof NO_SHOTS === 'undefined') {
      for (const v of ['final', 'source']) { P.setView(v); save(`${id}-${rate}-${v}.png`, await P.shot()); }
      P.setView('final');
    }
  }
}
log(out);
return { errors: P.gpuErrors.slice(0, 3) };
