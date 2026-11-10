# @pmndrs/reflections — agent notes

Reflections for WebGPU: probes, screen-space (FFX SSSR port, planned), and ray-traced fallback, with a hybrid resolve. The core is engine-agnostic, and three.js is the first adapter. **Read `docs/SPEC.md` first.** It holds the plan, the phases and their gates, and what moved here from the denoiser repo. Then `docs/HANDOFF.md` (who is on what, the agreed seams between workstreams, where each stopped) and `docs/DIVERGES.md` (every knowing difference from the sources, and when to revisit it).

## Commands

```bash
pnpm install
pnpm examples      # http://127.0.0.1:5370/<name>/  (5310 is another project's server; don't take it)
REFLECTIONS_PORT=5371 pnpm check   # worktrees use their own port (see docs/HANDOFF.md)
pnpm check         # headless Chrome + WebGPU over CDP; fails on validation errors/exceptions
pnpm check -- --compare http://127.0.0.1:5220/reflection-probes.html   # pixel parity vs the denoiser repo's page
pnpm typecheck && pnpm test && pnpm build
```

## Rules

1. `packages/core` never imports an engine. Adapters (`packages/three`, later babylon/pixi) wrap core and never re-implement its math.
2. Shader or pass changes are verified on a real GPU (`pnpm check`). "It builds" is not "it works".
3. Time with the render loop stopped. Don't compare absolute timings from a worktree against timings from the main checkout.
4. Commit after every run (experiment, measurement, build-out) with a message that gives what was tried, the numbers and the verdict, failures included. Stage explicit paths, never `git add -A`.
5. Push only when asked. Never publish to npm or push `v*` tags unless the maintainer asks.
6. The public API carries no AMD product marks. Attribution goes in `NOTICE` and in file headers.
7. Build features first; measure at gates. Time-box anything that fights you (~30 min), log it in `docs/HANDOFF.md`, move on.
8. Every knowing divergence from a source goes in `docs/DIVERGES.md`.
9. Denoising belongs in the `denoiser` repo. This repo talks to it through the denoise seam (SPEC, "Frame contract").
