import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * `src/domain/` is the pure layer: statistics, units, parsers, the draft gate.
 * It imports nothing from storage or the interface (#54).
 *
 * It had stopped being true. `domain/backupFormat.ts` imported record types and
 * the id rule from `data/`, while `data/store.ts`, `sync.ts` and `remote.ts`
 * imported the store's own snapshot type back from `domain/backupFormat` — the
 * two layers depended on each other, and the type at the heart of the store was
 * defined by a file-format module. Checked here so it cannot drift back.
 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

const DOMAIN = filesUnder('src/domain');

describe('the domain layer stands alone', () => {
  test('there are domain files to check, so a passing suite means something', () => {
    expect(DOMAIN.length).toBeGreaterThan(20);
  });

  test.each(DOMAIN)('%s imports nothing from data/ or ui/', (file) => {
    const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((path) => /(^|\/)(data|ui)(\/|$)/.test(path))).toEqual([]);
  });
});
