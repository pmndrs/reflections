// The few Node APIs the tests use (the repo has no @types/node; W51's settings-doc test reads and writes a file).
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
}
declare module 'node:path' {
  export function resolve(...parts: string[]): string;
}
declare const process: { env: Record<string, string | undefined>; cwd(): string };
