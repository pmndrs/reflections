// Stands in for a pixi-3d example while the closed-beta package isn't unpacked at
// examples/pixi3d/vendor/ (examples/vite.config.ts serves this source as the example's main.ts), so
// the gallery, CI and a public build work without the beta. The upscaler repo's notice, adapted.
const badge = document.getElementById('badge');
const status = document.getElementById('status');
if (badge) {
  badge.innerHTML = `<b>pixi-3d is in closed beta</b><br><br>
This example needs the <code>@pixi/3d</code> beta, which isn't on npm yet and isn't bundled here.
Beta testers: download the release tarball, then from the repo root
<pre>mkdir -p examples/pixi3d/vendor
tar -xzf pixi-3d-*.tgz -C examples/pixi3d/vendor --strip-components=1
pnpm examples</pre>
Details: <a href="https://github.com/pmndrs/reflections/blob/main/examples/pixi3d/README.md">examples/pixi3d/README.md</a>.`;
}
if (status) status.textContent = 'pixi-3d beta not found (examples/pixi3d/vendor/): showing the setup notice.';
// `pnpm check` asserts that this notice renders when there is no beta
Object.assign(window, { __p: { pixi3dUnavailable: true } });
export {};
