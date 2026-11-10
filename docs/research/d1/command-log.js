// D1: logs every WebGPU call per frame for the minimal scene (drive.mjs <url> command-log.js).
// Frames 1-3 issue identical commands (same pipeline, bind groups, buffers, no writes) yet frame 0 vs 1 differ.
(async () => {
  const P = window.__p;
  const R = P.renderer, THREE = P.THREE, dev = R.backend.device;
  const v = window.__variant || {};
  P.stop(); P.setObject('None');
  const s2 = new THREE.Scene();
  for (const m of P.grid.children) { const c = new THREE.InstancedMesh(m.geometry, P.gridMaterial, m.count); c.instanceMatrix.copy(m.instanceMatrix); s2.add(c); }
  P.gridMaterial.roughness = 0.05;
  P.scene.traverse((o) => { if (o.isPointLight) { const l = new THREE.PointLight(o.color, o.intensity); l.position.copy(o.position); s2.add(l); } });
  const rt = new THREE.RenderTarget(960, 540, { type: THREE.FloatType });
  let log = [];
  const wrap = (obj, name, fmt) => { const f = obj[name]; obj[name] = function (...a) { log.push(name + (fmt ? ':' + fmt(...a) : '')); return f.apply(this, a); }; };
  wrap(dev.queue, 'writeBuffer', (b, o, d) => `${b.label}@${o}`);
  wrap(dev.queue, 'writeTexture', (d) => `${d.texture.label}`);
  wrap(dev.queue, 'submit', (c) => c.length);
  wrap(dev, 'createBindGroup', (d) => d.label);
  wrap(dev, 'createBuffer', (d) => `${d.label} ${d.size} mapped=${!!d.mappedAtCreation}`);
  wrap(dev, 'createRenderPipeline', (d) => d.label);
  const ce = dev.createCommandEncoder.bind(dev);
  dev.createCommandEncoder = (d) => { const e = ce(d); const bp = e.beginRenderPass.bind(e); e.beginRenderPass = (pd) => { log.push('pass:' + (pd.label ?? '')); const p = bp(pd);
    const sp = p.setPipeline.bind(p); p.setPipeline = (x) => { log.push('pipe:' + x.label); sp(x); };
    const sb = p.setBindGroup.bind(p); p.setBindGroup = (i, g, ...r) => { log.push(`bg${i}:` + g.label); sb(i, g, ...r); };
    const sv = p.setVertexBuffer.bind(p); p.setVertexBuffer = (i, b, ...r) => { log.push(`vb${i}:${b?.label}:${r.join(',')}`); sv(i, b, ...r); };
    const si = p.setIndexBuffer.bind(p); p.setIndexBuffer = (b, ...r) => { log.push(`ib:${b?.label}:${r.join(',')}`); si(b, ...r); };
    const di = p.drawIndexed.bind(p); p.drawIndexed = (...r) => { log.push(`drawIndexed:${r.join(',')}`); di(...r); };
    const dr = p.draw.bind(p); p.draw = (...r) => { log.push(`draw:${r.join(',')}`); dr(...r); };
    return p; };
    const cb = e.copyBufferToBuffer.bind(e); e.copyBufferToBuffer = (...a) => { log.push('copyB2B'); cb(...a); };
    return e; };
  const out = []; let ref = null;
  for (let i = 0; i < 4; i++) {
    log = [];
    R.setRenderTarget(rt); R.render(s2, P.camera); R.setRenderTarget(null); R._animation.stop();
    const L = log;
    const buf = await R.readRenderTargetPixelsAsync(rt, 0, 0, 960, 540);
    if (!ref) ref = buf;
    let n = 0; for (let k = 0; k < buf.length; k++) if (buf[k] !== ref[k]) n++;
    out.push(`${i} n=${n}\n   ` + L.join('\n   '));
  }
  return out;
})()
