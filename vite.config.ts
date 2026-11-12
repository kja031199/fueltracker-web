/**
 * The build: the app, its service worker, and the self-hosted OCR reader.
 *
 * @trap #17 — The OCR reader is copied to `tesseract/<version>/` by
 * `tesseractAssets`. Its dev middleware tests a path with `Object.hasOwn`,
 * never `in`, which matched `constructor` and threw (#82). After touching the
 * scanner, the CSP or the service worker, run `node
 * scripts/ocr-check/check.mjs`: its CSP failures happen inside a worker, where
 * `cspWatch` cannot see them. Its probe is in `tsconfig.app.json`, so moving a
 * module it imports fails the typecheck.
 *
 * @trap #63 — `runtimeCaching` matchers are copied into `sw.js` as source text.
 * Use a RegExp, never a function that closes over a variable here: the first
 * tesseract route used `base`, threw inside `sw.js`, never matched, and offline
 * scanning failed. `ocrAssets.build.test.ts` checks the route is a RegExp.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Plugin } from 'vite';
// From vitest rather than vite: the same function, typed to know the `test`
// block below. This file is type-checked now (#57); with vite's own
// `defineConfig`, that block was an unknown property nobody was checking.
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** Served from the root of Firebase Hosting. */
const base = '/';

/**
 * `OCR_PROBE=1` adds the OCR browser check's probe page to the build (#17).
 * Only `scripts/ocr-check/check.mjs` sets it, into a throwaway directory; the
 * shipped site never contains the probe.
 */
const probe = process.env.OCR_PROBE === '1';

/** `.ts` tests that need a browser DOM: with every `.tsx` test, the `dom` project. */
const DOM_TESTS = 'src/**/*.dom.test.ts';
/** Tests that run against the Firestore emulator: the `rules` project. */
const EMULATOR_TESTS = 'src/**/*.emulator.test.{ts,tsx}';
/** Tests that read the built site in `dist/`: the `build` project. */
const BUILD_TESTS = 'src/**/*.build.test.{ts,tsx}';

/**
 * The receipt reader's files, served from this origin (#17).
 *
 * tesseract.js used to fetch its worker, its wasm core and the English data
 * from jsDelivr at scan time: third-party code, fetched at runtime, running
 * with this origin's access to the fuel log, and invisible to both the CSP
 * (an origin allowlist) and SRI (which never sees `fetch` → `Worker`). Now they
 * are copied out of `node_modules` at build time — **never committed** — so
 * they are exactly the versions `package-lock.json` pinned.
 *
 * The path carries the installed tesseract.js version, so an upgrade is a new
 * URL and can never be answered by a stale cached core from the last one; a
 * worker and core from different releases fail at scan time with nothing the
 * reader can act on. Paths are resolved, not hard-coded, for the same reason.
 *
 * Only the **LSTM** core variants are copied: `createWorker('eng', 1)` is
 * LSTM-only, and tesseract picks plain, SIMD or relaxed-SIMD by what the
 * device supports — so a device downloads one of the three. Each embeds its
 * wasm, which is why there are no `.wasm` files here.
 */
const requireFromHere = createRequire(import.meta.url);
const TESSERACT_VERSION = (requireFromHere('tesseract.js/package.json') as { version: string }).version;
const TESSERACT_ASSETS = `tesseract/${TESSERACT_VERSION}/`;
const TESSERACT_FILES: Readonly<Record<string, string>> = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'core/tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'core/tesseract-core-relaxedsimd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'lang/eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};

function tesseractAssets(): Plugin {
  const source = (file: string): string => requireFromHere.resolve(TESSERACT_FILES[file]!);
  return {
    name: 'fueltracker:tesseract-assets',
    // Build: emitted into the output under the versioned path.
    generateBundle() {
      for (const file of Object.keys(TESSERACT_FILES)) {
        this.emitFile({
          type: 'asset',
          fileName: `${TESSERACT_ASSETS}${file}`,
          source: readFileSync(source(file)),
        });
      }
    },
    // Dev: the same paths, served straight from `node_modules`.
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const prefix = `${base}${TESSERACT_ASSETS}`;
        const path = (request.url ?? '').split('?')[0] ?? '';
        const file = path.startsWith(prefix) ? path.slice(prefix.length) : null;
        // Own keys only (#82): `in` also finds what every object inherits, so
        // `/tesseract/<v>/constructor` reached `require.resolve(undefined)`.
        if (file === null || !Object.hasOwn(TESSERACT_FILES, file)) return next();
        response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        response.end(readFileSync(source(file)));
      });
    },
  };
}

export default defineConfig({
  define: {
    __TESSERACT_ASSETS__: JSON.stringify(TESSERACT_ASSETS),
  },
  plugins: [
    react(),
    tesseractAssets(),
    VitePWA({
      // `prompt`, not `autoUpdate`. An automatic update activates a new service
      // worker and reloads the page, which would discard a fill-up someone was
      // halfway through typing. This app holds the only copy of their data, so
      // it asks rather than deciding for them.
      registerType: 'prompt',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'FuelTracker',
        short_name: 'FuelTracker',
        description: 'Track gas fill-ups and fuel economy. Kept on your device and synced to your own Google account.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f2f2f7',
        // The palette's light-mode blue, so the installed app's chrome matches
        // what it opens into.
        theme_color: '#005fc8',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            // Android crops an icon to whatever shape the launcher uses, so the
            // maskable one keeps its artwork inside the safe circle.
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // The scanner is the one thing deliberately left out of the precache.
        // Tesseract and the EXIF parser together are far larger than the whole
        // rest of the app, and precaching them would make every install pay for
        // a screen many people never open. They load on demand instead — which
        // is why scanning is the only part of this app that needs a network.
        globIgnores: ['**/scanner-*.js', '**/exif-*.js', '**/tesseract/**'],
        // …and the reader's self-hosted files (#17) are cached on **first use**
        // instead: about seven megabytes nobody pays for until they scan, after
        // which scanning works offline. Cache-first is safe because the path is
        // versioned — an upgrade is a new URL, never a stale hit.
        runtimeCaching: [
          {
            // A RegExp, never a function. workbox copies this into sw.js as
            // source text, so a function closing over anything here (the first
            // version used `base`) throws there and never matches — nothing was
            // cached and offline scanning failed. Workbox only lets a RegExp
            // match a cross-origin URL from its first character, so this one,
            // which starts mid-path, can only match this origin.
            urlPattern: /\/tesseract\/\d+\.\d+\.\d+\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-assets',
              // One version's worth of files, with room for an upgrade's.
              expiration: { maxEntries: 12 },
            },
          },
        ],
        // The Firebase chunks are deliberately **not** in that ignore list,
        // even though they are large and lazily imported. Sign-in is required,
        // and the auth provider is what restores the persisted session — so if
        // its chunk were missing from the cache, an offline reload would fail
        // its dynamic import and the app would not open at all. Paying ~170 KB
        // gzipped of precache is the price of the gate working offline.
        //
        // No runtime caching rule is added for Firestore or Google's auth
        // endpoints, and none should be: workbox only precaches same-origin
        // build output, so it never sits between the SDK and its own servers.
        // Firestore does its own offline handling, and a service worker
        // replaying stale auth responses from a cache is a security problem
        // rather than a feature.
        navigateFallback: `${base}index.html`,
        // The probe page has to load as itself, not as the app shell.
        ...(probe ? { navigateFallbackDenylist: [/\/scripts\//] } : {}),
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  base,
  build: {
    rollupOptions: {
      ...(probe ? { input: { main: 'index.html', probe: 'scripts/ocr-check/probe.html' } } : {}),
      output: {
        // Named rather than hashed-only, so the precache can exclude them by
        // pattern instead of by a hash that changes every build.
        manualChunks: (id: string) => {
          if (id.includes('tesseract.js')) return 'scanner';
          if (id.includes('exifr')) return 'exif';
          return undefined;
        },
      },
    },
  },
  test: {
    // Also what makes Testing Library unmount after every test: it registers
    // that cleanup only when it finds a global `afterEach` as it loads.
    globals: true,
    // One test's spies, stubbed globals and stubbed env never reach the next
    // (#97). These used to be restored by hand, in some files and not others.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // `npm run test:coverage` (#99): reported in CI's job summary, never a
    // threshold — a target makes the number the goal instead of the tests.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', 'src/test/**', '**/testing/**', 'src/vite-env.d.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
    // Node unless a project says otherwise: the domain and data suites need no
    // DOM and start faster without one.
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    // Four groups, chosen by the file's name (#97). `src/test/projects.test.ts`
    // holds every test file to exactly one, and holds the names to what the
    // files need. The project chooses the environment, not each file.
    projects: [
      {
        // `npm test`, with `dom`: needs nothing but Node.
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, DOM_TESTS, EMULATOR_TESTS, BUILD_TESTS],
        },
      },
      {
        // `npm test`, with `unit`: the components, and the few `.ts` files
        // that need a browser DOM, on jsdom.
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx', DOM_TESTS],
          exclude: [...configDefaults.exclude, EMULATOR_TESTS, BUILD_TESTS],
        },
      },
      {
        // `npm run test:rules`: the real `firestore.rules` on the emulator.
        extends: true,
        test: { name: 'rules', include: [EMULATOR_TESTS], globalSetup: ['src/test/needsEmulator.ts'] },
      },
      {
        // `npm run test:build`: the built site in `dist/`, built just before.
        extends: true,
        test: { name: 'build', include: [BUILD_TESTS], globalSetup: ['src/test/needsBuild.ts'] },
      },
    ],
  },
});
