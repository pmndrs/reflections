// W76: `?s.<field>=<value>` on the ssr page and the showcase sets `ScreenSpaceReflectionsPass.settings.<field>`
// from the first frame (the bench's keys: booleans as 1 / 0 or true / false, numbers as numbers, the rest as
// strings). For a link that reproduces a setting, and for comparisons that need it before any frame runs, e.g.
// the pre-W76 tracer: `?s.hitColorFilter=off&s.thicknessDepthFactor=0`.
export function ssrSettingsFromQuery(q: URLSearchParams): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of q) {
    if (!k.startsWith('s.')) continue;
    out[k.slice(2)] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  }
  return out;
}
