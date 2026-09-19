import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The manifest is generated at build time, so these read the built output.
 * They are cheap insurance against the class of PWA bug that only shows up on
 * a phone, days later, when someone tries to install the thing.
 *
 * **CI builds before it tests** precisely so these run there. They skip when
 * `dist/` is absent, which keeps `npm test` usable on a fresh clone — but a
 * test that always skips is barely different from one that was never written,
 * so the workflow order is load-bearing rather than incidental.
 */
const distPath = (name: string): string => join(process.cwd(), 'dist', name);

function readManifest(): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(distPath('manifest.webmanifest'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

const manifest = readManifest();

describe.skipIf(manifest === null)('the built web app manifest', () => {
  test('declares what an installed app needs', () => {
    expect(manifest!['name']).toBe('FuelTracker');
    expect(manifest!['display']).toBe('standalone');
    expect(manifest!['start_url']).toBeDefined();
    expect(manifest!['scope']).toBeDefined();
  });

  test('its theme colour is a palette value, not an invented one', () => {
    // #005FC8 is the light-mode accent blue the contrast tests measure, so the
    // installed app's chrome matches what it opens into.
    expect(String(manifest!['theme_color']).toLowerCase()).toBe('#005fc8');
  });

  test('ships both a plain and a maskable icon', () => {
    // Android crops an icon to the launcher's shape; without a maskable one it
    // crops the artwork instead of the padding.
    const icons = manifest!['icons'] as { sizes: string; purpose?: string }[];
    expect(icons.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(icons.some((icon) => icon.sizes === '512x512' && icon.purpose === undefined)).toBe(true);
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });

  test('every icon it names actually exists', () => {
    const icons = manifest!['icons'] as { src: string }[];
    for (const icon of icons) {
      const name = icon.src.split('/').pop()!;
      expect(() => readFileSync(distPath(name))).not.toThrow();
    }
  });

  test('a service worker was generated alongside it', () => {
    expect(() => readFileSync(distPath('sw.js'))).not.toThrow();
  });
});
