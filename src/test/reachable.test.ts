import { existsSync, readFileSync } from 'node:fs';
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
export function reachableFrom(
  entry: string,
  importsOfFile: (file: string) => readonly string[] = importsOf,
): Set<string> {
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

/** Code for tests only: `src/test/`, and a `testing/` folder beside the code it stands in for. */
export function isTestCode(file: string): boolean {
  return file.startsWith('src/test/') || /(^|\/)testing\//.test(file);
}

const PRODUCTION = sourcesUnder('src', false).filter((file) => !isTestCode(file));

/**
 * In-memory stand-ins production really runs (#96): `main.tsx` keeps a
 * signed-out device's data in `InMemoryRepository`s, and `useSync` falls back
 * to `InMemorySyncState`. Every other `InMemory*` is a test double, and lives
 * in a `testing/` folder.
 */
const PRODUCTION_IN_MEMORY: ReadonlyMap<string, string> = new Map([
  ['InMemoryRepository', 'src/data/repository.ts'],
  ['InMemorySyncState', 'src/data/syncState.ts'],
]);

/** The test doubles `file` declares: any `InMemory*` but the two production runs, there. */
export function strayDoubles(file: string, declared: readonly string[]): string[] {
  return declared.filter((name) => PRODUCTION_IN_MEMORY.get(name) !== file);
}

/** The `InMemory*` classes a source declares. */
export function inMemoryClasses(source: string): string[] {
  return [...source.matchAll(/\bclass\s+(InMemory\w*)/g)].map((match) => match[1]!);
}

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

  test('test code is src/test/ and testing/ folders, nothing else', () => {
    expect(isTestCode('src/test/fixtures.ts')).toBe(true);
    expect(isTestCode('src/data/testing/inMemoryRemote.ts')).toBe(true);
    expect(isTestCode('src/data/remote.ts')).toBe(false);
    expect(isTestCode('src/data/testingGround.ts')).toBe(false);
    expect(isTestCode('src/data/latest/x.ts')).toBe(false);
  });

  test('finds the in-memory classes a file declares, exported or not', () => {
    const source =
      'export class InMemoryRemoteStore implements RemoteStore {}\nclass InMemoryScoped {}\nclass Other {}\n// class InMemoryNot';
    expect(inMemoryClasses(source)).toEqual(['InMemoryRemoteStore', 'InMemoryScoped', 'InMemoryNot']);
    expect(inMemoryClasses('const store = new InMemoryRepository();')).toEqual([]);
  });

  test('an in-memory class is allowed only where production runs it', () => {
    expect(strayDoubles('src/data/repository.ts', ['InMemoryRepository'])).toEqual([]);
    expect(strayDoubles('src/data/sharing.ts', ['InMemoryRepository'])).toEqual(['InMemoryRepository']);
    expect(strayDoubles('src/data/remote.ts', ['InMemoryRemoteStore'])).toEqual(['InMemoryRemoteStore']);
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

  test('the app reaches no test code', () => {
    expect([...reached].filter(isTestCode)).toEqual([]);
  });

  test.each(PRODUCTION)('%s declares no test double', (file) => {
    expect(strayDoubles(file, inMemoryClasses(readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('the two in-memory classes production runs are where it runs them from', () => {
    for (const [name, file] of PRODUCTION_IN_MEMORY) {
      expect(inMemoryClasses(readFileSync(file, 'utf8'))).toContain(name);
      expect(reached.has(file)).toBe(true);
    }
  });
});
