import { describe, expect, test } from 'vitest';
import { importsOf, sourcesUnder } from './imports';

/**
 * The layers depend downward only: `ui/` on `data/` and `domain/`, `data/` on
 * `domain/`, and `domain/` on nothing of ours (#54, #93).
 *
 * `src/domain/` is the pure layer: statistics, units, parsers, the draft gate.
 * It had stopped being pure once — `domain/backupFormat.ts` imported record
 * types from `data/` while `data/` imported the store's snapshot type back from
 * it — and this test then read only `from '…'` in single quotes, so a
 * double-quoted, side-effect or dynamic import still crossed unseen. It now
 * reads every form through `importsOf`, and also keeps the libraries that make
 * a layer impure (React, Dexie, Firebase) out of `domain/`, and `ui/` out of
 * `data/`.
 */

const DOMAIN = sourcesUnder('src/domain');
const DATA = sourcesUnder('src/data');

/** A package, or a path under it: `firebase` and `firebase/firestore` alike. */
const IMPURE_PACKAGE = /^(react|react-dom|dexie|firebase|@firebase\/[^/]+)(\/|$)/;

function under(dir: string): (path: string) => boolean {
  return (path) => path === dir || path.startsWith(`${dir}/`);
}

export function domainViolations(imports: readonly string[]): string[] {
  return imports.filter((path) => under('src/data')(path) || under('src/ui')(path) || IMPURE_PACKAGE.test(path));
}

export function dataViolations(imports: readonly string[]): string[] {
  return imports.filter(under('src/ui'));
}

describe('the rules catch what they are for', () => {
  test('a domain file may import itself and plain packages, but not a layer above or an impure library', () => {
    expect(domainViolations(['src/domain/units', 'src/domain/stats/kpi'])).toEqual([]);
    expect(
      domainViolations([
        'src/data/records',
        'src/ui/format',
        'react',
        'react-dom/client',
        'dexie',
        'firebase/firestore',
        '@firebase/auth',
      ]),
    ).toHaveLength(7);
  });

  test('a name that only starts like a layer is not that layer', () => {
    expect(domainViolations(['src/database', 'src/uikit', 'reactive', 'dexie-extra', 'firebasex'])).toEqual([]);
  });

  test('data may not import ui', () => {
    expect(dataViolations(['src/ui/App', 'src/domain/units', 'src/data/store'])).toEqual(['src/ui/App']);
  });
});

describe('the domain layer stands alone', () => {
  test('there are domain files to check, so a passing suite means something', () => {
    expect(DOMAIN.length).toBeGreaterThan(20);
  });

  test.each(DOMAIN)('%s imports nothing from data/, ui/, React, Dexie or Firebase', (file) => {
    expect(domainViolations(importsOf(file))).toEqual([]);
  });
});

describe('the data layer never reaches up into the interface', () => {
  test('there are data files to check', () => {
    expect(DATA.length).toBeGreaterThan(20);
  });

  test.each(DATA)('%s imports nothing from ui/', (file) => {
    expect(dataViolations(importsOf(file))).toEqual([]);
  });
});
