import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';

/**
 * How much the browser downloads, held to a budget (#99).
 *
 * Nothing watched the bundle's size: the entry chunk was 145 KB gzipped and the
 * Firestore chunk 139 KB when this was written, and either could have doubled
 * with one careless import without anything saying so. Measured gzipped,
 * because that is what crosses the wire. Each budget leaves roughly a tenth of
 * headroom over what was measured: room to work, not room to drift. Raising one
 * is a decision for the pull request that needs it, written here with why.
 */

/** Gzipped kilobytes. */
const BUDGET = {
  /** The chunk `index.html` loads: the app shell, before anyone signs in. */
  entry: 160,
  /** Firestore, loaded once someone signs in (#90). */
  remoteStore: 155,
  /** Every other chunk: a screen, a reader, a helper. */
  other: 30,
} as const;

const ASSETS = 'dist/assets';
const chunks = readdirSync(ASSETS)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, kb: gzipSync(readFileSync(`${ASSETS}/${name}`)).length / 1024 }));

/** The script `index.html` loads, which is the entry chunk. */
const entryName = /<script[^>]+src="[^"]*\/assets\/([^"]+\.js)"/.exec(readFileSync('dist/index.html', 'utf8'))?.[1];

function budgetFor(name: string): number {
  if (name === entryName) return BUDGET.entry;
  if (name.startsWith('remoteStore-')) return BUDGET.remoteStore;
  return BUDGET.other;
}

describe('the bundle (#99)', () => {
  test('is there to measure: an entry chunk and the Firestore chunk', () => {
    expect(entryName).toBeDefined();
    expect(chunks.map((chunk) => chunk.name)).toContain(entryName);
    expect(chunks.some((chunk) => chunk.name.startsWith('remoteStore-'))).toBe(true);
  });

  test.each(chunks)('$name fits its budget', ({ name, kb }) => {
    expect(kb, `${name} is ${kb.toFixed(1)} KB gzipped`).toBeLessThanOrEqual(budgetFor(name));
  });
});
