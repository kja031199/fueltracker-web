/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * `exifr` ships types for its main entry only. The `mini` build is the same
 * `parse` function over a smaller format set, so it is declared here rather
 * than pulling in the full parser purely to satisfy the compiler.
 */
declare module 'exifr/dist/mini.esm.mjs' {
  export function parse(input: unknown, options?: unknown): Promise<Record<string, unknown> | undefined>;
}
