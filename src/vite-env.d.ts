/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Where the receipt reader's self-hosted files live, relative to the app's
 * base: `tesseract/<installed version>/`. Set by `vite.config.ts` (#17).
 */
declare const __TESSERACT_ASSETS__: string;

/**
 * `exifr` ships types for its main entry only. The `mini` build is the same
 * `parse` function over a smaller format set, so it is declared here rather
 * than pulling in the full parser purely to satisfy the compiler.
 */
declare module 'exifr/dist/mini.esm.mjs' {
  export function parse(input: unknown, options?: unknown): Promise<Record<string, unknown> | undefined>;
}
