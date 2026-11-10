// Analytic frame inputs for the core screen-space tracer: one compute pass ray-casts a tiny scene and
// writes exact depth (device z), world normal, material (r unused, g perceptual roughness, a = id / 255)
// and lit HDR colour (direct + diffuse only, no specular), so screen space sees everything there is.
//
// Scene: floor y = 0 (x < 0 mirror, id 1; x >= 0 roughness ramp 0 -> 0.7 over 6 m, id 2), a patterned
// wall at z = -6 (id 3, rough), two boxes (ids 4, 5, rough), sky beyond (id 0, far depth).

export const SCENE_WGSL = /* wgsl */ `
struct Scene { invViewProj: mat4x4f, viewProj: mat4x4f, eye: vec4f, size: vec2u, reverse: u32, pad: u32 };
@group(0) @binding(0) var<uniform> S: Scene;
@group(0) @binding(1) var o_depth: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var o_normal: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var o_material: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(4) var o_color: texture_storage_2d<rgba16float, write>;

struct Hit { t: f32, n: vec3f, id: u32 };
const BOX_A_MIN = vec3f(-2.6, 0.0, -3.6); const BOX_A_MAX = vec3f(-1.2, 1.2, -2.2);
const BOX_B_MIN = vec3f(1.4, 0.0, -4.6);  const BOX_B_MAX = vec3f(3.0, 1.8, -3.2);

fn hitBox(ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f, id: u32, h: ptr<function, Hit>) {
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv;
  let t1 = (bmax - ro) * inv;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let tnear = max(max(tn.x, tn.y), tn.z);
  let tfar = min(min(tf.x, tf.y), tf.z);
  if (tnear > 1e-4 && tnear < tfar && tnear < (*h).t) {
    var n = vec3f(0.0, 0.0, -sign(rd.z));
    if (tnear == tn.x) { n = vec3f(-sign(rd.x), 0.0, 0.0); } else if (tnear == tn.y) { n = vec3f(0.0, -sign(rd.y), 0.0); }
    *h = Hit(tnear, n, id);
  }
}

fn trace(ro: vec3f, rd: vec3f) -> Hit {
  var h = Hit(1e30, vec3f(0.0), 0u);
  if (rd.y < 0.0) { // floor
    let t = -ro.y / rd.y;
    let p = ro + t * rd;
    if (t > 1e-4 && abs(p.x) < 9.0 && p.z > -6.0 && p.z < 8.0) { h = Hit(t, vec3f(0.0, 1.0, 0.0), select(1u, 2u, p.x >= 0.0)); }
  }
  if (rd.z < 0.0) { // wall
    let t = (-6.0 - ro.z) / rd.z;
    let p = ro + t * rd;
    if (t > 1e-4 && t < h.t && abs(p.x) < 9.0 && p.y >= 0.0 && p.y < 9.0) { h = Hit(t, vec3f(0.0, 0.0, 1.0), 3u); }
  }
  hitBox(ro, rd, BOX_A_MIN, BOX_A_MAX, 4u, &h);
  hitBox(ro, rd, BOX_B_MIN, BOX_B_MAX, 5u, &h);
  return h;
}

fn hsv(h: f32) -> vec3f { return clamp(abs(fract(h + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0)); }

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= S.size)) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(S.size);
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let b = S.invViewProj * vec4f(ndc, 0.5, 1.0); // in front of the eye for forward and reverse Z
  let ro = S.eye.xyz;
  let rd = normalize(b.xyz / b.w - ro);
  let h = trace(ro, rd);
  if (h.id == 0u) {
    textureStore(o_depth, id.xy, vec4f(select(1.0, 0.0, S.reverse != 0u)));
    textureStore(o_normal, id.xy, vec4f(0.0));
    textureStore(o_material, id.xy, vec4f(0.0, 1.0, 0.0, 0.0));
    textureStore(o_color, id.xy, vec4f(mix(vec3f(0.5, 0.6, 0.75), vec3f(0.15, 0.25, 0.6), clamp(rd.y * 2.0, 0.0, 1.0)), 1.0));
    return;
  }
  let p = ro + h.t * rd;
  let clip = S.viewProj * vec4f(p, 1.0);
  textureStore(o_depth, id.xy, vec4f(clip.z / clip.w));
  textureStore(o_normal, id.xy, vec4f(h.n, 0.0));

  var albedo = vec3f(0.6);
  var rough = 0.9;
  var emissive = vec3f(0.0);
  switch (h.id) {
    case 1u: { albedo = vec3f(0.02); rough = 0.0; }
    case 2u: {
      rough = clamp(p.x / 6.0, 0.0, 1.0) * 0.7;
      let g = fract(p.xz);
      albedo = select(vec3f(0.08), vec3f(0.25), min(g.x, g.y) < 0.04);
    }
    case 3u: {
      rough = 1.0;
      let c = (i32(floor(p.x * 2.0)) + i32(floor(p.y * 2.0))) & 1;
      albedo = mix(hsv(floor(p.x / 2.0) * 0.13 + 0.05), vec3f(0.9), f32(c) * 0.6);
      if (p.y > 2.0 && p.y < 2.25) { emissive = vec3f(4.0, 3.0, 1.5); }
      if (abs(p.x - round(p.x / 3.0) * 3.0) < 0.06 && p.y < 4.0) { emissive = vec3f(0.5, 2.0, 4.0); }
    }
    case 4u: { albedo = vec3f(0.8, 0.15, 0.1); }
    default: { albedo = vec3f(0.1, 0.3, 0.85); }
  }
  if (S.pad != 0u) { rough = 0.0; } // ?allmirror: every surface a mirror (most rays per frame)
  textureStore(o_material, id.xy, vec4f(0.0, rough, 0.0, f32(h.id) / 255.0));

  let L = normalize(vec3f(-0.4, 0.8, 0.5));
  let shadowed = trace(p + h.n * 1e-3, L).id != 0u;
  let direct = vec3f(2.2, 2.0, 1.8) * max(dot(h.n, L), 0.0) * select(1.0, 0.0, shadowed);
  textureStore(o_color, id.xy, vec4f(albedo * (direct + vec3f(0.25, 0.28, 0.35)) + emissive, 1.0));
}
`;

/** Column-major lookAt (right-handed, camera looks down -z). */
export function lookAt(eye: number[], target: number[], up = [0, 1, 0]): Float32Array {
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

/** Column-major perspective for WebGPU clip space (z in [0, 1]); `reverse` maps near to 1. */
export function perspective(fovY: number, aspect: number, near: number, far: number, reverse = false): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[11] = -1;
  if (reverse) { m[10] = near / (far - near); m[14] = (near * far) / (far - near); } else { m[10] = far / (near - far); m[14] = (near * far) / (near - far); }
  return m;
}
