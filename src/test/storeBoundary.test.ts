import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Screens write through the fuel log, never the store (#56).
 *
 * Four screens used to be handed the raw `FuelTrackerStore`, call it, and then
 * call an `onChanged` they had been given — so "a write is followed by a
 * refresh and a sync" held only where someone remembered. With the store out of
 * reach, a screen can only write through `useFuelLog()`, which does both.
 *
 * Two components may still name it: `fuelLog.tsx`, which owns it, and
 * `App.tsx`, the composition root, which only hands it to the provider.
 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const STORE_IMPORT = /from\s+['"](\.\.\/)+data\/store['"]/;

function importsStore(source: string): boolean {
  return STORE_IMPORT.test(source);
}

const ALLOWED = new Set(['src/ui/fuelLog.tsx', 'src/ui/App.tsx']);

const COMPONENTS = filesUnder('src/ui')
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => file.endsWith('.tsx') && !/\.test\.tsx$/.test(file));

describe('screens cannot reach the store', () => {
  test('the detector finds a real import, so a clean result means something', () => {
    expect(importsStore("import type { FuelTrackerStore } from '../data/store';")).toBe(true);
    expect(importsStore('import { FuelTrackerStore } from "../../data/store";')).toBe(true);
    expect(importsStore("import { x } from '../data/storeWithDexie';")).toBe(false);
    expect(importsStore("import { x } from '../data/records';")).toBe(false);
  });

  test('there are components to check', () => {
    expect(COMPONENTS.length).toBeGreaterThan(15);
  });

  test('only the fuel log and the composition root import it', () => {
    const offenders = COMPONENTS.filter(
      (file) => !ALLOWED.has(file) && importsStore(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
