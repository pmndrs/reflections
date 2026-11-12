(() => {
  window.__mods = []; window.__errs = [];
  const used = (code) => {
    const names = (code.match(/var\s+(\w+)\s*:\s*texture_(?!storage)\w+/g) || []).map((s) => s.split(/\s+/)[1]);
    return names.filter((n) => (code.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length > 1);
  };
  const wrap = (name) => {
    const orig = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (desc) {
      try { const c = desc.fragment?.module?.__code; if (c) { const u = used(c); window.__mods.push({ label: desc.label ?? '', n: u.length, names: u, len: c.length }); } } catch {}
      return orig.call(this, desc);
    };
  };
  const sm = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (d) { const m = sm.call(this, d); try { m.__code = d.code; } catch {} return m; };
  wrap('createRenderPipeline'); wrap('createRenderPipelineAsync');
  const rd = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (d) { const dev = await rd.call(this, d); dev.addEventListener('uncapturederror', (e) => window.__errs.push(e.error.message.slice(0, 300))); return dev; };
})();
