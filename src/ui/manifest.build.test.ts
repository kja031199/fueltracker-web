import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The manifest is generated at build time, so these read the built output.
 * They are cheap insurance against the class of PWA bug that only shows up on
 * a phone, days later, when someone tries to install the thing.
 *
 * A `*.build.test.ts` file (#97): it runs in the `build` project, through
 * `npm run test:build`, which builds first — so it never reads a stale
 * `dist/`, and `npm test` on a fresh clone doesn't run it at all.
 */
const distPath = (name: string): string => join(process.cwd(), 'dist', name);

const manifest = JSON.parse(readFileSync(distPath('manifest.webmanifest'), 'utf8')) as Record<
  string,
  unknown
>;

describe('the built web app manifest', () => {
  test('declares what an installed app needs', () => {
    expect(manifest['name']).toBe('FuelTracker');
    expect(manifest['display']).toBe('standalone');
    expect(manifest['start_url']).toBeDefined();
    expect(manifest['scope']).toBeDefined();
  });

  test('its theme colour is a palette value, not an invented one', () => {
    // #005FC8 is the light-mode accent blue the contrast tests measure, so the
    // installed app's chrome matches what it opens into.
    expect(String(manifest['theme_color']).toLowerCase()).toBe('#005fc8');
  });

  test('ships both a plain and a maskable icon', () => {
    // Android crops an icon to the launcher's shape; without a maskable one it
    // crops the artwork instead of the padding.
    const icons = manifest['icons'] as { sizes: string; purpose?: string }[];
    expect(icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(icons.some((icon) => icon.sizes === '512x512' && icon.purpose === undefined)).toBe(true);
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  test('every icon it names actually exists', () => {
    const icons = manifest['icons'] as { src: string }[];
    for (const icon of icons) {
      const name = icon.src.split('/').pop()!;
      expect(() => readFileSync(distPath(name))).not.toThrow();
    }
  });

  test('a service worker was generated alongside it', () => {
    expect(() => readFileSync(distPath('sw.js'))).not.toThrow();
  });
});
