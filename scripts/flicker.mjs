// W85 / T1: the flicker section. One compact run of X0's flicker metrics (examples/shared/metrics/README.md) on a
// list of scenes under a list of configs, so a default can be A/B'd on flicker first.
//
//   pnpm check -- --only flicker
//   FLICKER_LABEL=base                                    # output: $OUT/flicker-<label>.json and .md
//   FLICKER_SCENES='ssr:contact,ssr:mirrorWall,bench:cubeFloor,bench:carConcept@w50,bench:sponza@hero'
//   FLICKER_CONFIGS='[{"label":"cone off","q":"s.hitColorFilter=off","ssr":{"hitColorFilter":"off"}}]'
//   FLICKER_REPEAT=2                                      # drift + orbit run this many times per page (the noise floor)
//
// A scene is `ssr:<scene>` (examples/ssr, today's page defaults) or `bench:<scene>[@pose][/method]` (the tuning bench,
// default method ours-denoised, pose hero). A config is { label, q (bench URL query, `s.<field>=...&hitSource=hits`),
// ssr (an object assigned to __p.ssr.settings on the ssr page), ssrEval (JS run on the ssr page before the metrics),
// benchEval (JS run on the bench page), url (extra ssr page query) }. No config = one config named 'defaults'.
// Reported per scene and region: rest drift (mean |a - b|, 8-bit luma; a, b = frames 120, 240 phase-aligned), the
// per-frame rest flicker, orbit std and d2, the 2x2 ratio (display and raw), the border edge-pan d2, the raw speckle %.
// Image-based: no timings. Rest of the metrics' definitions: examples/shared/metrics/README.md.
import fs from 'node:fs';
import path from 'node:path';

const r4 = (v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v);

function row(m, rep) {
  const regions = Object.keys(m.restDrift?.regions ?? {}).filter((k) => k !== 'whole');
  const out = {};
  for (const r of regions) {
    out[r] = {
      px: m.restDrift.regions[r].px,
      drift: r4(m.restDrift.regions[r].mean),
      pct8: r4(m.restDrift.regions[r].pctOver),
      rest: r4(m.restDrift.rest?.[r]?.mean),
      orbitStd: r4(m.orbitFlicker?.regions?.[r]?.std),
      d2: r4(m.orbitFlicker?.regions?.[r]?.d2),
      quad: r4(m.quadEnergy?.display?.[r]?.ratio),
      quadRaw: r4(m.quadEnergy?.signal?.[r]?.ratio),
      speckle: r4(m.speckle?.regions?.[r]?.pct),
    };
    if (rep) {
      out[r].drift2 = r4(rep.restDrift?.regions?.[r]?.mean);
      out[r].orbitStd2 = r4(rep.orbitFlicker?.regions?.[r]?.std);
    }
  }
  out._pan = r4(m.edgePan?.regions?.borderReflection?.d2);
  return out;
}

export async function flicker(ctx, pages) {
  const { openPage, check, PORT, OUT } = ctx;
  const label = process.env.FLICKER_LABEL ?? 'run';
  const scenes = (process.env.FLICKER_SCENES ?? 'ssr:contact,ssr:mirrorWall,bench:cubeFloor,bench:edgesFloor,bench:plateFloor,bench:carConcept@w50,bench:sponza@hero').split(',');
  const configs = process.env.FLICKER_CONFIGS ? JSON.parse(process.env.FLICKER_CONFIGS) : [{ label: 'defaults' }];
  const repeat = Number(process.env.FLICKER_REPEAT ?? 1);
  const file = path.join(OUT, `flicker-${label}.json`);
  fs.mkdirSync(OUT, { recursive: true });
  const out = { date: new Date().toISOString(), label, results: [] };
  const errors = [];
  const t0 = Date.now();
  for (const cfg of configs) {
    for (const spec of scenes) {
      const [kind, rest] = spec.split(':');
      const before = ctx.results.logs.length;
      let url, method = 'ours-denoised', name = rest;
      if (kind === 'ssr') {
        url = `http://127.0.0.1:${PORT}/ssr/?scene=${rest}${cfg.url ? '&' + cfg.url : ''}`;
      } else {
        const m = /^([^@/]+)(?:@([^/]+))?(?:\/(.+))?$/.exec(rest);
        const pose = m[2] ?? 'hero';
        method = m[3] ?? cfg.method ?? 'ours-denoised';
        name = m[1];
        url = `http://127.0.0.1:${PORT}/showcase/bench.html?manual&scene=${m[1]}&pose=${pose}&left=${method}&right=${method}${cfg.q ? '&' + cfg.q : ''}`;
      }
      const p = await openPage(url);
      pages.push(p);
      let res = null;
      try {
        if (kind === 'ssr') {
          await p.T('window.__p.stop()');
          if (cfg.ssr) await p.T(`Object.assign(window.__p.ssr.settings, ${JSON.stringify(cfg.ssr)})`);
          if (cfg.ssrEval) await p.T(cfg.ssrEval);
        } else {
          if (!(await p.T('window.__p.entries()')).includes(name)) { console.log(`  (${name}: not available, skipped)`); continue; }
          if (cfg.benchEval) await p.T(cfg.benchEval);
        }
        const o = kind === 'ssr' ? '' : `{ method: '${method}' }`;
        const call = (k, opt) => p.T(`window.__p.metrics.${k}(${kind === 'ssr' ? opt ?? '' : opt ? opt.replace(/^\{/, `{ method: '${method}', `) : o})`);
        const m = {
          restDrift: await call('restDrift'),
          orbitFlicker: await call('orbitFlicker'),
          quadEnergy: await call('quadEnergy'),
          edgePan: await call('edgePan'),
          speckle: await call('speckle'),
        };
        let rep = null;
        for (let i = 1; i < repeat; i++) rep = { restDrift: await call('restDrift'), orbitFlicker: await call('orbitFlicker') };
        res = row(m, rep);
        errors.push(...(await p.T(kind === 'ssr' ? 'window.__p.gpuErrors' : 'window.__p.gpuErrors()')), ...ctx.results.logs.slice(before).filter((l) => /invalid|validation|uncaptured|exception/i.test(l)));
      } finally {
        p.close(); const k = pages.indexOf(p); if (k >= 0) pages.splice(k, 1);
      }
      out.results.push({ config: cfg.label ?? 'defaults', scene: spec, ...res && { regions: res } });
      fs.writeFileSync(file, JSON.stringify(out, null, 1));
      const R = res.reflection ?? res.glossy ?? Object.values(res)[0];
      console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)} s] ${cfg.label ?? 'defaults'} | ${spec}: reflection drift ${R?.drift}${R?.drift2 !== undefined ? ' / ' + R.drift2 : ''} rest ${R?.rest} orbit std ${R?.orbitStd}${R?.orbitStd2 !== undefined ? ' / ' + R.orbitStd2 : ''} d2 ${R?.d2} quad ${R?.quad}/${R?.quadRaw} pan ${res._pan} speckle ${R?.speckle}`);
    }
  }
  // markdown: one table per region name across scenes x configs
  const names = [...new Set(out.results.flatMap((x) => Object.keys(x.regions ?? {}).filter((k) => !k.startsWith('_'))))];
  let md = `# flicker ${label} (${out.date})\n`;
  for (const rn of names) {
    md += `\n## ${rn}\n\n| config | scene | px | drift | %>8 | rest | orbit std | d2 | quad | raw quad | speckle % | pan d2 |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const x of out.results) {
      const v = x.regions?.[rn]; if (!v) continue;
      md += `| ${x.config} | ${x.scene} | ${v.px} | ${v.drift}${v.drift2 !== undefined ? ' / ' + v.drift2 : ''} | ${v.pct8} | ${v.rest} | ${v.orbitStd}${v.orbitStd2 !== undefined ? ' / ' + v.orbitStd2 : ''} | ${v.d2} | ${v.quad} | ${v.quadRaw} | ${v.speckle} | ${x.regions._pan} |\n`;
    }
  }
  fs.writeFileSync(path.join(OUT, `flicker-${label}.md`), md);
  check('flicker: every scene x config ran, no GPU errors', out.results.length > 0 && errors.length === 0, `${((Date.now() - t0) / 60000).toFixed(1)} min; ${file}${errors.length ? '; ' + errors[0] : ''}`);
}
