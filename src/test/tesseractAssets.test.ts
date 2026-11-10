import { createRequire } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import config from '../../vite.config';

/**
 * The dev server's receipt-reader files (#17), served from `node_modules` by
 * `vite.config.ts`'s `fueltracker:tesseract-assets` plugin.
 *
 * Only the files it names are served (#82). It used to test the name with
 * `in`, which also finds what every object inherits — so
 * `/tesseract/<v>/constructor` reached `require.resolve(undefined)` and threw
 * inside the dev server. Dev only, never the build, but a server that throws
 * on a crafted path is a server that throws.
 */

type Middleware = (
  request: { url?: string },
  response: { setHeader: (name: string, value: string) => void; end: (body: unknown) => void },
  next: () => void,
) => void;

/** Vite's plugin list nests (a plugin may be an array of plugins). */
function flatten(list: unknown): unknown[] {
  return Array.isArray(list) ? list.flatMap(flatten) : [list];
}

function middleware(): Middleware {
  const plugin = flatten(config.plugins ?? []).find(
    (candidate): candidate is { name: string; configureServer: unknown } =>
      typeof candidate === 'object' && candidate !== null && (candidate as { name?: unknown }).name === 'fueltracker:tesseract-assets',
  );
  expect(plugin, 'the tesseract assets plugin').toBeDefined();
  let used: Middleware | null = null;
  (plugin!.configureServer as (server: unknown) => void)({
    middlewares: {
      use: (handler: Middleware) => {
        used = handler;
      },
    },
  });
  expect(used).not.toBeNull();
  return used!;
}

const version = (createRequire(import.meta.url)('tesseract.js/package.json') as { version: string }).version;

function request(path: string) {
  const response = { setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  middleware()({ url: `/tesseract/${version}/${path}` }, response, next);
  return { response, next };
}

describe('the dev server serves only the reader files it names', () => {
  test('a named file is served, with its type', () => {
    const { response, next } = request('worker.min.js');
    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/javascript');
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', 'isPrototypeOf'])(
    'an inherited name, %s, is passed on rather than thrown on',
    (name) => {
      const { response, next } = request(name);
      expect(next).toHaveBeenCalledTimes(1);
      expect(response.end).not.toHaveBeenCalled();
    },
  );

  test('anything else is passed on', () => {
    for (const path of ['nope.js', '', 'core/../worker.min.js']) {
      const { response, next } = request(path);
      expect(next, path).toHaveBeenCalledTimes(1);
      expect(response.end, path).not.toHaveBeenCalled();
    }
  });
});
