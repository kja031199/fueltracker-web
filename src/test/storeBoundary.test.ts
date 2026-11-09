import { describe, expect, test } from 'vitest';
import { importsIn, importsOf, resolved, sourcesUnder } from './imports';

/**
 * Screens write through the fuel log, never the store (#56, #93).
 *
 * Four screens used to be handed the raw `FuelTrackerStore`, call it, and then
 * call an `onChanged` they had been given — so "a write is followed by a
 * refresh and a sync" held only where someone remembered. With the store out of
 * reach, a screen can only write through `useFuelLog()`, which does both.
 *
 * This used to look at `.tsx` files only, with its own pattern. Hooks and
 * helpers are `.ts`, and a helper handed the store is a screen's way round
 * the log, so every interface file is checked now, through the shared reader
 * that also sees double quotes and dynamic `import()`. Each file that may
 * name the store is listed with the reason.
 */

const STORE = 'src/data/store';

const ALLOWED: Record<string, string> = {
  'src/ui/App.tsx': 'the composition root: it hands the store to the providers',
  'src/ui/fuelLog.tsx': 'owns the store for the screens; every write goes through it',
  'src/ui/useAppData.ts': 'the fuel log’s load of what the screens show',
  'src/ui/useSync.ts': 'runs a sync against the store for the fuel log',
  'src/ui/exportBackup.ts': 'takes the snapshot a backup is made from; only the fuel log calls it',
  'src/ui/useSharingView.ts': 'the sharing lists the fuel log shows; only the fuel log calls it',
  'src/ui/fuelLogTypes.ts': 'the fuel log’s own interface names the shape of a new vehicle (a type only)',
};

export function namesStore(file: string, source: string): boolean {
  return importsIn(source).some((specifier) => resolved(file, specifier) === STORE);
}

const INTERFACE = sourcesUnder('src/ui', false);

describe('screens cannot reach the store', () => {
  test('the detector finds the store in every form, so a clean result means something', () => {
    const file = 'src/ui/screens/Thing.tsx';
    expect(namesStore(file, "import type { FuelTrackerStore } from '../../data/store';")).toBe(true);
    expect(namesStore(file, 'import { FuelTrackerStore } from "../../data/store";')).toBe(true);
    expect(namesStore(file, "const m = await import('../../data/store');")).toBe(true);
    expect(namesStore(file, "export { FuelTrackerStore } from '../../data/store';")).toBe(true);
    expect(namesStore(file, "import { x } from '../../data/storeWithDexie';")).toBe(false);
    expect(namesStore(file, "import { x } from '../../data/records';")).toBe(false);
    expect(namesStore(file, "// import { FuelTrackerStore } from '../../data/store';")).toBe(false);
  });

  test('there are interface files to check, hooks and helpers included', () => {
    expect(INTERFACE.filter((file) => file.endsWith('.tsx')).length).toBeGreaterThan(15);
    expect(INTERFACE.filter((file) => file.endsWith('.ts')).length).toBeGreaterThan(5);
  });

  test('every allowed file exists and still needs to be allowed', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(INTERFACE, file).toContain(file);
      expect(importsOf(file), file).toContain(STORE);
    }
  });

  test('only the files listed, for their reasons, import it', () => {
    const offenders = INTERFACE.filter((file) => !(file in ALLOWED) && importsOf(file).includes(STORE));
    expect(offenders).toEqual([]);
  });
});
