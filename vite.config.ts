import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Built for GitHub Pages, which serves from a repository subpath.
  base: process.env.PAGES_BASE ?? '/',
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
