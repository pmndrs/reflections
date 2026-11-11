# What pixi-3d would need to expose for screen-space reflections

For the pixi team. Written 2026-11-10 against the pixi-3d beta 0.1.0-beta.2 with the temporal branch (`DepthOutputPass`, `MotionVectorPass`, `Camera3D.jitter`), from building `@pmndrs/reflections/pixi` on it (W19; `examples/pixi3d/arcade`).

## What already works

Screen-space reflections read a small G-buffer (the "frame contract": depth, normal, roughness, metalness, albedo, motion, and the lit colour without the environment's specular) plus the camera. pixi-3d provides much of it through public API:

| input | pixi-3d | notes |
|---|---|---|
| scene colour | render the `View3D` into an rgba16float `RenderTexture`, `toneMapping: 'custom'` | linear HDR, as wanted |
| depth | `DepthOutputPass` | view-sized, standard Z. depth24plus-stencil8 is fine: we bind a depth-only view and copy it |
| motion | `MotionVectorPass` | NDC delta, unjittered, per object. Reprojects correctly (GPU-checked) |
| camera | `Camera3D.view`, `unjitteredProjection`, `near`, `far`, `jitter` | GL clip z, which we remap. Lands on pixi-3d's pixels to 0.001 px |
| probe faces | `Camera3D({ renderTexture })` + `BackgroundPass({ camera })` + `MeshPass({ name: 'opaque', camera })` | six of them make a cube capture, sky included (the BackgroundPass from a `'beforeOpaque'` Pass3D listed before the MeshPass, as the `PortalPass` docs show) |
| material hook | `Material3D({ extraBits })` | how we take the environment's specular out of the colour |

## What's missing, most important first

### 1. Normals and material values as an output (the G-buffer)

Nothing outputs per-pixel normals, roughness, metalness or base colour. A custom pass can redraw the meshes, but its shader is compiled without the material plugins, so it can't read the `Material` struct or sample the material's textures.

**What we do now:** a `ForwardRenderPass` on its own membership (shaped like `MotionVectorPass`) whose shader reads two texels of the material's row in `uMaterialStorage` (`baseColor`, `pbrParams`). That relies on the store's internal layout (16 texels per material, Material3D's field packing), and it gets the material's constants only. Base-colour, metallic-roughness and normal maps, flat shading and the geometric specular AA term don't reach it.

**Ask, either of:**
- (a) A `GBufferOutputPass` (like `DepthOutputPass`) that writes the shading normal (world space, after normal mapping and the double-sided flip), perceptual roughness (as shaded, before or after the geometric AA term: document which), metalness and linear base colour into view-sized textures. One rgba16float (normal + roughness) and one rgba8unorm (base colour + metalness) is what we use. Opt-in, so scenes that don't need it pay nothing.
- (b) Let a pass reuse the material's own bits with a pass template: compile a custom pass's shader with the material plugins (struct access, texture getters) and a template of the pass's choosing, so `fragmentMaterial` runs and the template writes whatever outputs it wants. (a) could then be built on (b) outside pixi-3d.

MRT for the opaque pass itself (writing the G-buffer during the main draw, no second geometry pass) would be the fastest, but (a) or (b) is enough.

### 2. The lit colour without the environment's specular

Reflections replace the environment's specular reflection (screen-space where possible, probes elsewhere), so the colour they're added to must not already contain it, or it counts twice.

**What we do now:** an `extraBits` entry in the post-lighting slot recomputes iblBit's single-scatter term from the same locals and subtracts it. It works, but only for materials built with the bit (construction-time), only with an environment set, and it duplicates iblBit's maths (clearcoat and sheen environment lobes stay in).

**Ask:** a view (or material) switch that leaves the environment's specular lobe out of the lit colour: `view.environmentSpecular = false`, or an output of the lit colour without it. Diffuse environment light stays.

### 3. A cube capture

**What we do now:** six 90-degree cameras with render textures, each drawn by a `BackgroundPass({ camera })` (added from a `'beforeOpaque'` Pass3D) and then a `MeshPass({ name: 'opaque', camera })`, and a compute pass that mirrors x as it stacks the faces into a cube (a cube face is the mirror image of a camera's view). The sky comes out equal to the Hemisphere formula texel for texel, so this works with public API. (Until W33 we drew only the `MeshPass`, and the probe saw black where the sky is.)

**Ask:** a cube camera / `CubeRenderTexture` capture that draws the full view (background included) into the six faces of a cube texture in WebGPU's orientation, in one call. The same thing pixi-3d's own reflection probes would want. Not a blocker any more: it would replace twelve passes and our stacking pass.

**Seen along the way:** a `View3D` with no mesh at all draws nothing, not even its background (`View3DPipeGpu` returns before the graph runs when `_meshSlots.count === 0`). A probe captured in an empty view (or a sky-only test) stays black; we add a sub-texel speck in our check. Drawing the background for an empty view would be the expected behaviour.

### 4. Smaller things

- **Depth in a sampleable single-aspect format.** `DepthOutputPass` hands back depth24plus-stencil8. We copy it to r32float each frame because some consumers can't bind a combined depth-stencil whole. An option for `depth32float` would remove the copy.
- **BRDF LUT access.** A composite outside the material system (a pixi `Filter`) can't reach the view's BRDF table, so we use Karis' analytic fit. Exposing the LUT texture (or its generator) would let the composite match pixi-3d's own split-sum exactly.
- **A stable material-store contract** if (1) doesn't happen: document `uMaterialStorage`'s row layout for Material3D, or give pass shaders a `getMaterial()` accessor.
- **An `extraBits` hook after construction** (or `material.addBit()`), so a library can adapt materials it didn't create (glTF).

## How it's verified on our side

`pnpm check -- --only pixi3d` in pmndrs/reflections, with the beta unpacked into `examples/pixi3d/vendor/`. It checks that the contract's camera reprojects onto pixi-3d's pixels, that G-buffer normals agree with normals derived from the depth, that the probe captures sample as world directions and see the view's sky, that the motion reprojects, and that the glossy floor reflects confidently.
