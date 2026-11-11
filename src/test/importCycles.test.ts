import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { importsOf, sourcesUnder } from './imports';

/**
 * No import cycles in `src/data` (#91) — type-only imports included.
 *
 * A cycle is two modules that each need the other to be understood, which is
 * how the data layer had drifted: the store imported the import code, which
 * imported its types back from the store. Read as text, the way the other
 * boundary tests read the source (`imports.ts`, #93), so it needs nothing
 * installed.
 */

const ROOT = 'src/data';

/** Every module of ours a file imports or re-exports, as a file under `src/data` — through the shared reader. */
function edges(file: string): string[] {
  return importsOf(file)
    .map((path) => [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`].find((candidate) => FILES.has(candidate)))
    .filter((path): path is string => path !== undefined);
}

const FILES = new Set(sourcesUnder(ROOT, false));
const GRAPH = new Map([...FILES].map((file) => [file, edges(file)]));

/** Each cycle once, as the path that closes it. */
function cycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const found: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  function visit(node: string): void {
    seen.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) found.push([...stack.slice(stack.indexOf(next)), next]);
      else if (!seen.has(next)) visit(next);
    }
    stack.pop();
    onStack.delete(node);
  }
  for (const node of [...graph.keys()].sort()) if (!seen.has(node)) visit(node);
  return found;
}

describe('src/data has no import cycles (#91)', () => {
  test('there is a graph to check, so a passing suite means something', () => {
    expect(FILES.size).toBeGreaterThan(20);
    expect([...GRAPH.values()].flat().length).toBeGreaterThan(40);
  });

  test('the cycle finder finds one when there is one', () => {
    expect(
      cycles(
        new Map([
          ['a', ['b']],
          ['b', ['c']],
          ['c', ['a']],
        ]),
      ),
    ).toEqual([['a', 'b', 'c', 'a']]);
    expect(
      cycles(
        new Map([
          ['a', ['b']],
          ['b', []],
        ]),
      ),
    ).toEqual([]);
  });

  test('none, type-only imports included', () => {
    const shown = cycles(GRAPH).map((cycle) => cycle.map((file) => relative(ROOT, file)).join(' → '));
    expect(shown).toEqual([]);
  });
});

describe('the storage modules depend on nothing above them (#91)', () => {
  // The bottom of the data layer: records, repositories, the database and its
  // adapters, the cursor, the ledger, the clocks. They used to reach up — the
  // clock into the store, the database and the cursor into sharing — so
  // naming a membership pulled in the whole sharing world.
  const BOTTOM = [
    'records.ts',
    'recordMapping.ts',
    'repository.ts',
    'atomically.ts',
    'db.ts',
    'dexieRepository.ts',
    'dexieState.ts',
    'syncState.ts',
    'shareLedger.ts',
    'syncClock.ts',
    'sharingTypes.ts',
  ].map((name) => join(ROOT, name));
  const ABOVE = [
    'store.ts',
    'sync.ts',
    'shareSync.ts',
    'sharing.ts',
    'backup.ts',
    'localView.ts',
    'accountStore.ts',
  ].map((name) => join(ROOT, name));

  test('they all exist, so a passing suite means something', () => {
    for (const file of [...BOTTOM, ...ABOVE]) expect(FILES.has(file), file).toBe(true);
  });

  test.each(BOTTOM)('%s imports none of the store, sync or sharing modules', (file) => {
    const reaching = (GRAPH.get(file) ?? []).filter((target) => ABOVE.includes(target));
    expect(reaching).toEqual([]);
  });
});

describe('src/data draws nothing and speaks to no page (#91)', () => {
  // Decoding a photo, reading its date, and choosing the words for a message
  // are the screens' work. They used to sit in `data/`.
  const BROWSER = /\bdocument\.|HTMLCanvasElement|OffscreenCanvas|createImageBitmap|getContext\(|new Image\(/;

  test.each([...FILES])('%s uses no DOM or canvas', (file) => {
    expect(readFileSync(file, 'utf8')).not.toMatch(BROWSER);
  });
});
