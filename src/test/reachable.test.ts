import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { importsOf, sourcesUnder } from './imports';

/**
 * Every production file is part of the app, or says why it is not (#96).
 *
 * A two-car comparison and an odometer parser were ported from iOS, tested,
 * kept up to date through two refactors — and never shown on any screen.
 * Code nothing runs still costs every change that touches it. This walks the
 * imports from the page's one entry point, dynamic ones included, and refuses
 * a file under `src/` that the walk never reaches, unless it is listed in
 * `KEPT` with the reason.
 *
 * It is file-sized on purpose. An unused *export* inside a used file is the
 * smaller cousin of this, and telling one apart from a helper exported for its
 * test needs a judgement a grep cannot make.
 */

/** The page's entry point, as `index.html` loads it. */
const ENTRY = 'src/main.tsx';

/** Files nothing imports yet, each with the reason and the issue it waits on. */
const KEPT: ReadonlyMap<string, string> = new Map([
  ['src/domain/scanning/odometerScanParser.ts', 'odometer scanning, #143'],
  // Ambient declarations: the compiler reads them, nothing imports them.
  ['src/vite-env.d.ts', 'type declarations for Vite'],
]);

/** The file a relative specifier names, the way the bundler resolves it. */
function fileFor(path: string): string | null {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`, `${path}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source file reachable from `entry` through its imports. */
export function reachableFrom(entry: string, importsOfFile: (file: string) => readonly string[] = importsOf): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const path of importsOfFile(file)) {
      if (!path.startsWith('src/')) continue;
      const next = fileFor(path);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/**
 * What is wrong with the `KEPT` list: a kept file that has gone, or one the app
 * now reaches. Either way it should leave the list, or the list goes stale.
 */
export function staleKept(
  kept: Iterable<string>,
  reached: ReadonlySet<string>,
  exists: (file: string) => boolean = existsSync,
): string[] {
  return [...kept].flatMap((file) => {
    if (!exists(file)) return [`${file} no longer exists`];
    if (reached.has(file)) return [`${file} is used now`];
    return [];
  });
}

const PRODUCTION = sourcesUnder('src', false).filter((file) => !file.startsWith('src/test/'));

describe('the walk', () => {
  test('follows the app’s imports, including the ones loaded later', () => {
    const reached = reachableFrom(ENTRY);
    expect(reached).toContain('src/ui/App.tsx');
    // Loaded with `import()` once someone signs in.
    expect(reached).toContain('src/data/firebase/remoteStore.ts');
    expect(reached).toContain('src/domain/format.ts');
  });

  test('stops at files no one imports', () => {
    const graph: Record<string, readonly string[]> = {
      'src/a.ts': ['src/b', 'react'],
      'src/b.ts': ['src/a'],
      'src/orphan.ts': ['src/a'],
    };
    const reached = reachableFrom('src/a.ts', (file) => graph[file] ?? []);
    expect([...reached].sort()).toEqual(['src/a.ts']);
  });

  test('a kept file leaves the list once it is used, or gone', () => {
    const reached = new Set(['src/used.ts']);
    const exists = (file: string) => file !== 'src/gone.ts';
    expect(staleKept(['src/waiting.ts'], reached, exists)).toEqual([]);
    expect(staleKept(['src/used.ts', 'src/gone.ts', 'src/waiting.ts'], reached, exists)).toEqual([
      'src/used.ts is used now',
      'src/gone.ts no longer exists',
    ]);
  });
});

describe('src/ (#96)', () => {
  const reached = reachableFrom(ENTRY);

  test.each(PRODUCTION.filter((file) => !KEPT.has(file)))('%s is part of the app', (file) => {
    expect(reached.has(file)).toBe(true);
  });

  test('every kept file still exists and is still unused', () => {
    expect(staleKept(KEPT.keys(), reached)).toEqual([]);
  });
});
