// Types for the pathtracer sibling's bench-only NRC modules (`@nrc-bench/*`) and `@pmndrs/pathtracer`: untyped on purpose
// (private, unpublished, edited elsewhere); examples/nrc narrows what it uses.
declare module '@nrc-bench/*';
declare module '@pmndrs/pathtracer';
/** Set by examples/vite.config.ts: true when the sibling pathtracer checkout (bench modules) resolves. */
declare const __NRC_AVAILABLE__: boolean;
