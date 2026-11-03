import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * The receipt reader's files, in the built output (#17).
 *
 * Copied from `node_modules` at build time — never committed — under a path
 * that carries the installed tesseract.js version, so an upgrade can never be
 * served a stale cached core. Reads `dist/`, so it skips on a fresh clone and
 * runs in CI, which builds first (see `manifest.test.ts`).
 */
const require = createRequire(import.meta.url);
const version = (require('tesseract.js/package.json') as { version: string }).version;
const assets = join(process.cwd(), 'dist', 'tesseract', version);
const built = existsSync(join(process.cwd(), 'dist', 'index.html'));

const COPIES: readonly (readonly [string, string])[] = [
  ['worker.min.js', require.resolve('tesseract.js/dist/worker.min.js')],
  ['core/tesseract-core-lstm.wasm.js', require.resolve('tesseract.js-core/tesseract-core-lstm.wasm.js')],
  ['core/tesseract-core-simd-lstm.wasm.js', require.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm.js')],
  [
    'core/tesseract-core-relaxedsimd-lstm.wasm.js',
    require.resolve('tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js'),
  ],
  ['lang/eng.traineddata.gz', require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')],
];

describe.skipIf(!built)('the self-hosted reader in the build', () => {
  test.each(COPIES)('%s is shipped, byte for byte what is installed', (served, source) => {
    // Byte-identical, because the worker and the core must come from the same
    // release: a mismatch fails at scan time, on a phone, with no error the
    // reader can act on.
    const path = join(assets, served);
    expect(existsSync(path), path).toBe(true);
    expect(readFileSync(path).equals(readFileSync(source))).toBe(true);
  });

  const sw = (): string => readFileSync(join(process.cwd(), 'dist', 'sw.js'), 'utf8');

  test('none of it is precached, so installing the app costs what it did', () => {
    // About seven megabytes a device would download on install for a screen
    // many people never open. Fetched on first scan instead.
    expect(sw()).not.toMatch(/url:\s*"tesseract\//);
  });

  test('it is cached on first use, so scanning then works offline', () => {
    expect(sw()).toContain('tesseract-assets');
  });

  test('the route that caches it can actually match', () => {
    // workbox serialises a `runtimeCaching` matcher into sw.js as source text.
    // The first version was a function closing over `base` from vite.config —
    // which does not exist in sw.js, so the matcher threw, nothing was ever
    // cached, and scanning offline failed. A RegExp literal carries no outside
    // references. The browser check (`scripts/ocr-check`) caught this.
    const route = /registerRoute\(([^,]+),new \w+\.CacheFirst\(\{cacheName:"tesseract-assets"/.exec(sw());
    expect(route, 'no tesseract runtime route in sw.js').not.toBeNull();
    expect(route![1]).toMatch(/^\/.*tesseract.*\/[gimsuy]*$/);
  });
});
