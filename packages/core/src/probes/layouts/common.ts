// WGSL shared by the layouts: cube face maths (WebGPU face rules) and the octahedral map.

/** Direction through (u, v) in [-1, 1] on a face of a WebGPU cube; and the inverse face pick. */
export const CUBE_WGSL = /* wgsl */ `
fn pl_faceDirUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}
// Face and face uv in [0, 1] of a direction, by WebGPU's cube face selection: vec3(u, v, face).
fn pl_cubeFaceUV(d: vec3<f32>) -> vec3<f32> {
  let a = abs(d);
  var face = 0u; var sc = 0.0; var tc = 0.0; var ma = 1.0;
  if (a.x >= a.y && a.x >= a.z) {
    ma = a.x; tc = -d.y;
    if (d.x >= 0.0) { face = 0u; sc = -d.z; } else { face = 1u; sc = d.z; }
  } else if (a.y >= a.z) {
    ma = a.y; sc = d.x;
    if (d.y >= 0.0) { face = 2u; tc = d.z; } else { face = 3u; tc = -d.z; }
  } else {
    ma = a.z; tc = -d.y;
    if (d.z >= 0.0) { face = 4u; sc = d.x; } else { face = 5u; sc = -d.x; }
  }
  return vec3(vec2(sc, tc) / ma * 0.5 + 0.5, f32(face));
}`;

/**
 * Full-sphere octahedral map with +y as the pole (y-up engines put the sky in the centre diamond).
 * `pl_octaEncode` maps a direction to [-1, 1]^2; `pl_octaWrap` folds a point outside the square
 * back in (the continuation across the border, used to fill the gutter); `pl_octaDecode` inverts.
 */
export const OCTA_WGSL = /* wgsl */ `
fn pl_signNZ(v: vec2<f32>) -> vec2<f32> { return select(vec2(-1.0), vec2(1.0), v >= vec2(0.0)); }
fn pl_octaEncode(dir: vec3<f32>) -> vec2<f32> {
  let d = dir.xzy; // pole along +y
  var p = d.xy / (abs(d.x) + abs(d.y) + abs(d.z));
  if (d.z < 0.0) { p = (1.0 - abs(p.yx)) * pl_signNZ(p); }
  return p;
}
fn pl_octaDecode(p: vec2<f32>) -> vec3<f32> {
  var n = vec3(p, 1.0 - abs(p.x) - abs(p.y));
  let t = max(-n.z, 0.0);
  n = vec3(n.xy - t * pl_signNZ(n.xy), n.z);
  return normalize(n).xzy;
}
fn pl_octaWrap(q: vec2<f32>) -> vec2<f32> {
  var p = q;
  if (abs(p.x) > 1.0) { p = vec2(sign(p.x) * 2.0 - p.x, -p.y); }
  if (abs(p.y) > 1.0) { p = vec2(-p.x, sign(p.y) * 2.0 - p.y); }
  return p;
}`;
