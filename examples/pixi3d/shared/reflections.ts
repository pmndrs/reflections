// The pixi-3d side of @pmndrs/reflections/pixi: the pieces that need the beta's classes, so they live
// with the examples (typechecked by examples/pixi3d/tsconfig.json against the vendored beta) and
// never in the published adapter. Each one is what pixi-3d itself would ideally provide
// (docs/research/pixi3d-needs.md):
//
//   ReflectionsGBufferPass   normals + roughness + metalness + base colour: pixi-3d has no G-buffer
//                            output. A forward redraw of the opaque meshes that opted in, with the
//                            adapter's shader (REFLECTIONS_GBUFFER_SHADER), copied into a view-sized
//                            rgba32float texture like DepthOutputPass / MotionVectorPass do.
//   reflectiveMaterial()     a Material3D with REFLECTIONS_SCENE_COLOR_BIT (the colour without the
//                            environment's specular) that opts into the G-buffer pass.
//   ProbeCapture             six 90-degree cameras with render textures, drawing the opaque scene
//                            (MeshPass 'opaque' per camera, pixi-3d's security-camera pattern).
import {
  Camera3D, ForwardRenderPass, Material3D, MeshPass, Pass3D, View3D,
  type Material3DOptions, type PassBuilder, type PassContext, type RenderGraph, type RenderSession, type ShaderBit, type ShaderDescriptorOptions,
} from '@pixi/3d';
import { RenderTexture, Texture, TextureSource, type WebGPURenderer } from 'pixi.js';
import {
  REFLECTIONS_GBUFFER_FORMAT, REFLECTIONS_GBUFFER_PASS, REFLECTIONS_GBUFFER_SHADER, REFLECTIONS_SCENE_COLOR_BIT, type PixiProbeSet,
} from '@pmndrs/reflections/pixi';

const gbufferDescriptor = {
  bitsGpu: [...REFLECTIONS_GBUFFER_SHADER.bitsGpu],
  template: REFLECTIONS_GBUFFER_SHADER.template,
} as unknown as ShaderDescriptorOptions;

/**
 * Draws the reflections G-buffer (REFLECTIONS_GBUFFER_FORMAT, packing in the adapter's pixi3d.ts)
 * each frame into `texture`, the view's physical size, after the opaque pass. Materials opt in with
 * `material.enablePass(REFLECTIONS_GBUFFER_PASS)` (reflectiveMaterial() does). WebGPU only.
 */
export class ReflectionsGBufferPass extends Pass3D {
  readonly stage = 'afterOpaque' as const;
  readonly texture: Texture;

  constructor() {
    super();
    this.texture = new Texture({
      source: new TextureSource({
        format: REFLECTIONS_GBUFFER_FORMAT, width: 1, height: 1, resolution: 1, autoGenerateMipmaps: false, scaleMode: 'nearest', label: 'reflectionsGBuffer',
      }),
      label: 'reflectionsGBuffer',
    });
  }

  build(graph: RenderGraph, ctx: PassContext): void {
    graph.addPass(new GBufferRenderPass(ctx.renderer as WebGPURenderer, graph, this));
  }

  override destroy(): void {
    this.texture.destroy(true);
  }
}

// MotionVectorPass's render pass, with the reflections shader: own colour + depth from the graph's
// pool, then the content rect copied into the owner's texture.
class GBufferRenderPass extends ForwardRenderPass {
  private readonly owner: ReflectionsGBufferPass;
  private readonly gpuRenderer: WebGPURenderer;
  private readonly color: ReturnType<RenderGraph['createColor']>;
  private readonly depth: ReturnType<RenderGraph['createDepth']>;
  private readonly output: ReturnType<RenderGraph['importColor']>;

  constructor(renderer: WebGPURenderer, graph: RenderGraph, owner: ReflectionsGBufferPass) {
    super({
      renderer,
      name: REFLECTIONS_GBUFFER_PASS,
      description: 'Draws normals, roughness, metalness and base colour for @pmndrs/reflections into a view-sized rgba32float texture.',
      descriptor: { shaderDescriptor: gbufferDescriptor },
      sort: 'key',
      textures: false,
    });
    this.owner = owner;
    this.gpuRenderer = renderer;
    this.color = graph.createColor({ format: REFLECTIONS_GBUFFER_FORMAT, scaleMode: 'nearest', label: 'reflectionsGBuffer' });
    this.depth = graph.createDepth({ label: 'reflectionsGBufferDepth' });
    this.output = graph.importColor(() => owner.texture);
  }

  override setup(b: PassBuilder): void {
    b.writeColor(this.color);
    b.writeDepth(this.depth);
    b.produce(this.output);
  }

  // every frame, so the texture is fresh (and cleared) even with no mesh opted in
  override condition(): boolean {
    return true;
  }

  override render(session: RenderSession): void {
    super.render(session);
    const renderer = this.gpuRenderer;
    renderer.renderTarget.finishRenderPass();
    const color = session.view3d._graph.getTexture(this.color, session);
    const { frame, source } = color;
    const r = source.resolution;
    const x = Math.round(frame.x * r), y = Math.round(frame.y * r);
    const width = Math.max(1, Math.round(frame.width * r)), height = Math.max(1, Math.round(frame.height * r));
    const texture = this.owner.texture;
    if (texture.source.pixelWidth !== width || texture.source.pixelHeight !== height) texture.source.resize(width, height, 1);
    texture.frame.width = width;
    texture.frame.height = height;
    texture.updateUvs();
    renderer.encoder.commandEncoder.copyTextureToTexture(
      { texture: renderer.texture.getGpuSource(source), origin: { x, y } },
      { texture: renderer.texture.getGpuSource(texture.source) },
      { width, height },
    );
    session.activeTarget = null;
  }
}

/** A Material3D that reflects: the colour without the environment's specular, and in the G-buffer pass. */
export function reflectiveMaterial(options: Material3DOptions = {}): Material3D {
  const material = new Material3D({ ...options, extraBits: [...(options.extraBits ?? []), REFLECTIONS_SCENE_COLOR_BIT as unknown as ShaderBit] });
  material.enablePass(REFLECTIONS_GBUFFER_PASS);
  return material;
}

/**
 * Opts every material under `root` into the G-buffer pass (for materials made elsewhere, e.g. a
 * glTF). Those keep pixi-3d's own environment specular in their colour, so the reflection adds on
 * top of it; use reflectiveMaterial() where that matters.
 */
export function enableReflectionsGBuffer(root: { children: unknown[] }): void {
  const visit = (node: { children?: unknown[]; material?: unknown }) => {
    if (node.material instanceof Material3D) node.material.enablePass(REFLECTIONS_GBUFFER_PASS);
    for (const child of node.children ?? []) visit(child as typeof node);
  };
  visit(root);
}

// WebGPU cube face order (+X, -X, +Y, -Y, +Z, -Z): where each camera looks and its up vector.
// PixiProbeSet.captureFaces mirrors x as it stacks them, which puts each image as a texture_cube
// lookup reads it (checked on the GPU by the example's orientation check).
const FACES: readonly { forward: [number, number, number]; up: [number, number, number] }[] = [
  { forward: [1, 0, 0], up: [0, 1, 0] },
  { forward: [-1, 0, 0], up: [0, 1, 0] },
  { forward: [0, 1, 0], up: [0, 0, -1] },
  { forward: [0, -1, 0], up: [0, 0, 1] },
  { forward: [0, 0, 1], up: [0, 1, 0] },
  { forward: [0, 0, -1], up: [0, 1, 0] },
];

/**
 * Captures probes with pixi-3d: six 90-degree Camera3Ds with rgba16float render textures, each drawn
 * by a MeshPass on the 'opaque' membership (pixi-3d's own render-to-texture path), then handed to
 * the PixiProbeSet. The sky behind is not drawn by a MeshPass, so a face's clear colour stands in for
 * it (`background`, linear rgb).
 */
export class ProbeCapture {
  readonly cameras: Camera3D[];
  readonly faces: RenderTexture[];
  private readonly passes: MeshPass[];

  constructor(private readonly view: View3D, size: number, near = 0.05, far = 100) {
    this.faces = FACES.map(() => RenderTexture.create({ width: size, height: size, resolution: 1, format: 'rgba16float', antialias: false, autoGenerateMipmaps: false }));
    this.cameras = FACES.map((_, i) => new Camera3D({ fov: 90, near, far, renderTexture: this.faces[i] }));
    for (const c of this.cameras) view.root.addChild(c);
    this.passes = this.cameras.map((camera) => new MeshPass({ name: 'opaque', camera, stage: 'beforeOpaque' }));
  }

  /** Renders the six faces from `position` with `renderer` and captures them into `slot`. */
  capture(renderer: WebGPURenderer, probes: PixiProbeSet, slot: number, position: readonly [number, number, number]) {
    FACES.forEach((f, i) => {
      const c = this.cameras[i];
      c.position.set(position[0], position[1], position[2]);
      c.lookAt({ x: position[0] + f.forward[0], y: position[1] + f.forward[1], z: position[2] + f.forward[2] }, { x: f.up[0], y: f.up[1], z: f.up[2] });
    });
    // only the capture draws (the view's own passes would resize their outputs to the scratch)
    const passes = this.view.passes;
    this.view.passes = this.passes;
    const scratch = RenderTexture.create({ width: 16, height: 16, resolution: 1, format: 'rgba16float', antialias: false });
    renderer.render({ container: this.view, target: scratch });
    this.view.passes = passes;
    scratch.destroy(true);
    probes.captureFaces(slot, this.faces);
  }

  destroy() {
    for (const c of this.cameras) c.destroy();
    for (const f of this.faces) f.destroy(true);
  }
}
