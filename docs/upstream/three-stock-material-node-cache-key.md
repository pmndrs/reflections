# Draft issue for mrdoob/three.js

> Status: **filed as [mrdoob/three.js#35485](https://github.com/mrdoob/three.js/issues/35485)** (2026-11-12). Found by W46 (DIVERGES D3572); minimal repro confirmed on r187, headless Chrome, WebGPU, macOS (Apple M-series), 2026-11-12, and again by the maintainer in a fiddle (stock material wrong, `MeshBasicNodeMaterial` correct). The repro page is in `docs/upstream/three-stock-material-node-cache-key.html`.

---

**Title:** WebGPURenderer: stock materials with a `*Node` property share one pipeline / node graph (cache key ignores the node)

### Description

On a **non-node** material (`MeshBasicMaterial`, `MeshStandardMaterial`, …) rendered by `WebGPURenderer`, setting a node property such as `colorNode` or `roughnessNode` works for the first material. A second material that differs **only in that node** reuses the first one's compiled node graph, so it renders with the first material's node.

The cause appears to be the render object's material cache key:
- `RenderObject.getMaterialCacheKey()` starts from `NodeManager.getCustomProgramCacheKey(material)`. For a stock material, that is `Material.prototype.customProgramCacheKey()`, i.e. `onBeforeCompile.toString()`. Only `NodeMaterial.customProgramCacheKey()` hashes its child nodes (`childNode.getCacheKey(true)`).
- It then walks the material's own properties. A node-valued property is an `object`, so it contributes just `'{}'`, and a texture contributes only its sampler state.
- Two stock materials whose nodes differ therefore get the same key, and `NodeManager.getForRender()` returns the cached `nodeBuilderState` built for the first one.

`NodeLibrary.fromMaterial()` copies the `*Node` properties onto the node material it builds, so they do take effect, which is why this looks supported. But the key is computed on the original stock material.

### Reproduction steps

1. Create two `MeshBasicMaterial`s. Set `colorNode = texture(red)` on one and `colorNode = texture(blue)` on the other, using two 1×1 `DataTexture`s with identical sampler settings.
2. Put each on a plane, side by side, and render once with `WebGPURenderer`.
3. Both planes are red. Expected: left red, right blue.

The same happens with constant nodes (`color(0xff0000)` vs `color(0x0000ff)`). With `MeshBasicNodeMaterial` instead of `MeshBasicMaterial`, the output is correct.

### Code

```js
import * as THREE from 'three/webgpu';
import { color, texture } from 'three/tsl';

const renderer = new THREE.WebGPURenderer();
await renderer.init();
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera( - 2, 2, 1, - 1, 0.1, 10 );
camera.position.z = 5;

const solid = ( hex ) => {
	const t = new THREE.DataTexture( new Uint8Array( [ ( hex >> 16 ) & 255, ( hex >> 8 ) & 255, hex & 255, 255 ] ), 1, 1 );
	t.needsUpdate = true;
	return t;
};

function plane( node, x ) {
	const material = new THREE.MeshBasicMaterial(); // a stock material
	material.colorNode = node;
	const mesh = new THREE.Mesh( new THREE.PlaneGeometry( 1.8, 1.8 ), material );
	mesh.position.x = x;
	scene.add( mesh );
}

plane( texture( solid( 0xff0000 ) ), - 1 ); // red
plane( texture( solid( 0x0000ff ) ), 1 );   // blue, but renders red
// also wrong: plane( color( 0xff0000 ), - 1 ); plane( color( 0x0000ff ), 1 );

await renderer.renderAsync( scene, camera );
```

### Results (r187)

Pixel at the centre of each plane:

| setup | left | right | expected right |
|---|---|---|---|
| `MeshBasicMaterial`, `colorNode = texture(...)` | 255,0,0 | **255,0,0** | 0,0,255 |
| `MeshBasicMaterial`, `colorNode = color(...)` | 255,0,0 | **255,0,0** | 0,0,255 |
| `MeshBasicNodeMaterial`, `colorNode = texture(...)` | 255,0,0 | 0,0,255 | 0,0,255 |

### Where we hit it

We set `roughnessNode` (Toksvig roughness from each material's own normal map) on every normal-mapped glTF `MeshStandardMaterial`. Materials that differed only in their normal map all shaded with the first one's map; in Sponza, the curtains took a column's normal variance.

### Workaround

Give each material a distinct `customProgramCacheKey`, e.g.:

```js
material.customProgramCacheKey = () => `${ THREE.Material.prototype.customProgramCacheKey.call( material ) }|${ node.id }`;
```

Or convert to the `*NodeMaterial` class yourself.

### Possible fix

- In `RenderObject.getMaterialCacheKey()`, key node-valued properties by `value.getCacheKey()` when `value.isNode`, not as `'{}'`.
- Or have the stock-material path use the node material's `customProgramCacheKey()` (after `fromMaterial`).

Alternatively, if `*Node` properties on stock materials aren't meant to be supported, a warning (or a docs note) would save the next person the debugging.

### Version

r187 (0.187.0)

### Device / Browser / OS

Desktop, Chrome (WebGPU, Metal backend), macOS. The logic is backend-independent, so we expect the same everywhere.
