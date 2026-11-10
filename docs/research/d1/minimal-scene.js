// D1 repro, minimal scene (two grid InstancedMeshes + two PointLights; no shadows, env or probes), on examples/probes:
//   node docs/research/d1/drive.mjs http://127.0.0.1:5387/probes/ docs/research/d1/minimal-scene.js 'window.__variant={rt32:true,n:16,busy:4}'
// Per frame: floats differing from frame 0 [min, median, max relative diff]. Variants: rough, normalMat, single, deriv,
// pos, vdir, lvp, light, busy (full-scene renders between frames), perturb, raw (compute dispatch), sleep.
(async () => {
  const P = window.__p;
  const R = P.renderer, THREE = P.THREE;
  const v = window.__variant || {};
  P.stop(); P.setObject('None');
  const s2 = new THREE.Scene();
  const T = THREE.TSL; let mat0 = null;
  if (v.deriv) { mat0 = new THREE.MeshBasicNodeMaterial(); const n = T.normalView.normalize(); mat0.colorNode = T.vec3(n.dFdx().abs().max(n.dFdy().abs())).mul(v.deriv); }
  if (v.pos) { mat0 = new THREE.MeshBasicNodeMaterial(); mat0.colorNode = T.positionView.mul(v.pos); }
  if (v.vdir) { mat0 = new THREE.MeshBasicNodeMaterial(); mat0.colorNode = T.positionViewDirection.normalize(); }
  if (v.lvp) { mat0 = new THREE.MeshBasicNodeMaterial(); window.__lvp = true; }
  if (v.light) { mat0 = new THREE.MeshStandardNodeMaterial({ metalness: 1, roughness: 0.05 }); mat0.roughnessNode = T.float(v.light); }
  const mat = mat0 ? mat0 : v.normalMat ? new THREE.MeshNormalNodeMaterial() : P.gridMaterial;
  for (const m of P.grid.children) { const c = v.single ? new THREE.Mesh(m.geometry, mat) : new THREE.InstancedMesh(m.geometry, mat, m.count); if (v.single) c.position.set(-3, 2.5, 0); else c.instanceMatrix.copy(m.instanceMatrix); s2.add(c); }
  P.gridMaterial.roughness = v.rough ?? 0.05;
  P.scene.traverse((o) => { if (o.isPointLight) { const l = new THREE.PointLight(o.color, o.intensity); l.position.copy(o.position); s2.add(l); } });
  if (v.lvp) { const ls = s2.children.filter((o) => o.isPointLight); mat0.colorNode = T.lightViewPosition(ls[0]).sub(T.positionView).normalize().add(T.lightViewPosition(ls[1]).mul(1e-3)); }
  const rt = new THREE.RenderTarget(960, 540, { type: v.rt32 ? THREE.FloatType : THREE.HalfFloatType });
  const rtB = new THREE.RenderTarget(960, 540, { type: THREE.HalfFloatType });
  const dev = R.backend.device; let raw = null;
  if (v.raw) { const sb = dev.createBuffer({ size: 1 << 22, usage: GPUBufferUsage.STORAGE });
    const pl = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: `@group(0) @binding(0) var<storage, read_write> b: array<f32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3u) { var x = f32(g.x); for (var i = 0u; i < ${v.raw}u; i++) { x = sin(x) * 1.0001 + 0.5; } b[g.x % (1u << 20u)] = x; }` }), entryPoint: 'main' } });
    const bg = dev.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: sb } }] });
    raw = () => { const e = dev.createCommandEncoder(); const p = e.beginComputePass(); p.setPipeline(pl); p.setBindGroup(0, bg); p.dispatchWorkgroups(4096); p.end(); dev.queue.submit([e.finish()]); }; }
  const out = []; let ref = null;
  for (let i = 0; i < (v.n ?? 12); i++) {
    if (v.perturb && i % 3 === 1) { R.setRenderTarget(rtB); R.render(P.scene, P.camera); }
    if (v.sleep && (v.sleepEvery ? i % v.sleepEvery === 0 : true)) await new Promise((r) => setTimeout(r, v.sleep));
    if (v.busy) { const t = performance.now(); for (let k = 0; k < v.busy; k++) { R.setRenderTarget(rtB); R.render(P.scene, P.camera); } }
    if (raw) raw();
    R.setRenderTarget(rt); R.render(s2, P.camera); R.setRenderTarget(null); R._animation.stop();
    const buf = await R.readRenderTargetPixelsAsync(rt, 0, 0, 960, 540);
    if (!ref) ref = buf;
    let n = 0; const rel = []; for (let k = 0; k < buf.length; k++) if (buf[k] !== ref[k]) { n++; rel.push(Math.abs(buf[k] - ref[k]) / Math.max(1e-6, Math.abs(ref[k]))); }
    rel.sort((a, b) => a - b); const q = (f) => rel.length ? rel[Math.floor(f * (rel.length - 1))].toExponential(1) : '-';
    if (n && !window.__pts) { window.__pts = []; for (let k = 0; k < buf.length; k += 4) { let d = false; for (let c = 0; c < 3; c++) if (buf[k + c] !== ref[k + c]) d = true; if (d) window.__pts.push([(k / 4) % 960, Math.floor(k / 4 / 960), +ref[k].toFixed(4), +buf[k].toFixed(4)]); } }
    out.push(`${n}[${q(0)},${q(0.5)},${q(1)}]`);
  }
  return { out: out.join(' '), pts: window.__pts };
})()
