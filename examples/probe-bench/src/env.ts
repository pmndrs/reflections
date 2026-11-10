// The bench's HDR test environment: a procedural sky whose high-contrast features sit on cube face
// edges and on the octahedral folds (texture-space directions, +y up; octa pole +y, so the horizon
// is the octa diamond fold and the lower-hemisphere meridians x = 0 and z = 0 are its border).
//
//   sun       radius 1 deg, 500, at azimuth 45 deg just above the horizon: on the vertical cube
//             edge (+x, +z) and on the octa diamond fold.
//   lamp      radius 1.5 deg, 200, at the cube corner (+1, +1, -1).
//   windows   20, rectangles: across the (+x, -z) vertical cube edge; across the (+y, +z) top
//             edge; across the octa border below the horizon (x = 0, z < 0).
//   lines     3, 0.3 deg wide: lower-hemisphere meridians every 45 deg (the octa border and the
//             vertical cube edges), and the 45 deg elevation ring (crosses the top face edges).
//   sky / ground  a smooth gradient, 0.1 ... 1.

export const ENV_WGSL = /* wgsl */ `
fn envAzEl(d: vec3<f32>) -> vec2<f32> { return vec2(atan2(d.x, d.z), asin(clamp(d.y, -1.0, 1.0))); }
fn envAngDist(a: vec3<f32>, b: vec3<f32>) -> f32 { return acos(clamp(dot(a, b), -1.0, 1.0)); }
fn envWrap(a: f32) -> f32 { return a - 6.283185307 * round(a / 6.283185307); }
fn envRadiance(dir: vec3<f32>) -> vec3<f32> {
  let d = normalize(dir);
  let ae = envAzEl(d);
  let deg = 0.017453292;
  var c: vec3<f32>;
  if (d.y >= 0.0) {
    c = mix(vec3(0.9, 0.95, 1.0), vec3(0.2, 0.35, 0.8), sqrt(d.y));
  } else {
    c = mix(vec3(0.3, 0.25, 0.2), vec3(0.08, 0.07, 0.06), sqrt(-d.y));
  }
  // windows (azimuth, elevation, half width, half height), radians
  let wins = array<vec4<f32>, 3>(
    vec4(135.0, 15.0, 10.0, 12.0) * deg,            // across the (+x, -z) vertical edge (azimuth atan2(1, -1))
    vec4(0.0, 45.0, 14.0, 6.0) * deg,               // across the (+y, +z) top edge (elevation 45 at azimuth 0)
    vec4(180.0, -30.0, 6.0, 10.0) * deg,            // across the octa border (x = 0, z < 0)
  );
  for (var i = 0u; i < 3u; i++) {
    let w = wins[i];
    if (abs(envWrap(ae.x - w.x)) < w.z && abs(ae.y - w.y) < w.w) { c = vec3(20.0, 18.0, 15.0); }
  }
  // thin lines: lower meridians every 45 deg, and the 45 deg elevation ring
  let lw = 0.15 * deg;
  if (d.y < 0.0) {
    let m = envWrap(ae.x * 8.0) / 8.0; // distance to the nearest multiple of 45 deg, in azimuth
    if (abs(m) * cos(ae.y) < lw) { c = vec3(3.0, 2.5, 2.0); }
  }
  if (abs(ae.y - 45.0 * deg) < lw) { c = vec3(2.0, 3.0, 2.0); }
  // lamp and sun
  if (envAngDist(d, normalize(vec3(1.0, 1.0, -1.0))) < 1.5 * deg) { c = vec3(200.0, 180.0, 150.0); }
  if (envAngDist(d, normalize(vec3(cos(2.0 * deg) * 0.70710678, sin(2.0 * deg), cos(2.0 * deg) * 0.70710678))) < 1.0 * deg) { c = vec3(500.0, 480.0, 420.0); }
  return c;
}`;

/** Compute pass: rasterize ENV_WGSL into every face of a cube (4x4 supersampled box filter). */
export const ENV_CUBE_WGSL = /* wgsl */ `${ENV_WGSL}
@group(0) @binding(0) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(1) var<uniform> size: vec4<u32>;
fn faceDirUV(face: u32, u: f32, v: f32) -> vec3<f32> {
  switch face {
    case 0u: { return vec3( 1.0, -v, -u); }
    case 1u: { return vec3(-1.0, -v,  u); }
    case 2u: { return vec3( u,  1.0,  v); }
    case 3u: { return vec3( u, -1.0, -v); }
    case 4u: { return vec3( u, -v,  1.0); }
    default: { return vec3(-u, -v, -1.0); }
  }
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = size.x;
  if (id.x >= n || id.y >= n) { return; }
  var c = vec3(0.0);
  for (var j = 0u; j < 4u; j++) {
    for (var i = 0u; i < 4u; i++) {
      let uv = (vec2<f32>(id.xy) + (vec2(f32(i), f32(j)) + 0.5) / 4.0) / f32(n) * 2.0 - 1.0;
      c += envRadiance(faceDirUV(id.z, uv.x, uv.y));
    }
  }
  textureStore(dst, id.xy, id.z, vec4(c / 16.0, 1.0));
}`;
