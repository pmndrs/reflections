// Stand-in for `@nrc-bench/*` (pmndrs/pathtracer's bench-only NRC modules) when examples/vite.config.ts finds no sibling
// pathtracer checkout: examples/nrc shows a notice (`__NRC_AVAILABLE__` is false) and never imports through it.
throw new Error('@nrc-bench is not available: clone pmndrs/pathtracer next to this repo or set NRC_PATHTRACER_REPO');
