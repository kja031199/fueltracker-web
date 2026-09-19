import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  plugins: [
    react(),
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
        description:
          'Track gas fill-ups and fuel economy. Local-first: no account, no server.',
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
        // Nothing here is fetched from a network at runtime — no API, no CDN,
        // no fonts — so precaching the shell is the whole offline story.
        navigateFallback: `${base}index.html`,
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  // Built for GitHub Pages, which serves from a repository subpath.
  base,
  test: {
    globals: true,
    // Node by default: the domain and data suites need no DOM and start
    // faster without one. Component tests opt in per file with a
    // `@vitest-environment jsdom` docblock, so the cost is paid only where
    // it buys something.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
