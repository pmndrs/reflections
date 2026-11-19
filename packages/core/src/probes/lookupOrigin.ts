// The probe-lookup position for a surface whose world position was rebuilt from the depth buffer
// (W87 D5420 in three's composite, W88 D5440 in core's radiance fallback). The rebuilt P is off by
// ~1e-6 x distance, either sign, so a surface lying on a probe volume's face (a floor probe's box
// starts at the floor) lands either side of the face per pixel and per jitter phase, and the lookup
// flips between the volume and the environment slot. Moving the lookup off the surface along its
// normal by more than that error fixes the side. Only the probe lookup moves; ray origins and hit
// tests keep P. One definition for every adapter and for core's WGSL, so they cannot drift apart.

/** Offset per unit of view distance (about 3x the depth-rebuild error). */
export const PROBE_LOOKUP_NUDGE_SCALE = 2e-5;
/** Constant offset in world units. */
export const PROBE_LOOKUP_NUDGE_BIAS = 1e-5;

/** The nudge in world units at view distance `dist`. */
export const probeLookupNudge = (dist: number): number => PROBE_LOOKUP_NUDGE_SCALE * dist + PROBE_LOOKUP_NUDGE_BIAS;

/** WGSL: `probeLookupOrigin(P_world, N_world, view_distance)`. */
export const PROBE_LOOKUP_ORIGIN_WGSL = /* wgsl */ `
fn probeLookupOrigin(P_world: vec3f, N_world: vec3f, view_distance: f32) -> vec3f {
  return P_world + N_world * (${PROBE_LOOKUP_NUDGE_SCALE.toExponential()} * view_distance + ${PROBE_LOOKUP_NUDGE_BIAS.toExponential()});
}
`;
