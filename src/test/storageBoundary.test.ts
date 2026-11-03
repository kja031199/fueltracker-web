import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Exactly one module touches web storage: `ui/preferences.ts` (#55).
 *
 * Five modules used to each carry their own copy of
 * `try { localStorage… JSON.parse… validate } catch { fallback }`, and each
 * decided for itself whether its key belonged to the browser or the account.
 * Three of them decided wrong. With one door, the scope is a declared property
 * of every key rather than something each new key has to remember.
 */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Code only: prose about `localStorage` in a comment is not a use of it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const STORAGE = /\b(localStorage|sessionStorage)\b/;

function usesWebStorage(source: string): boolean {
  return STORAGE.test(withoutComments(source));
}

const SOURCES = filesUnder('src').filter((file) => !/\.test\.tsx?$/.test(file));

describe('web storage has one door', () => {
  test('the detector finds a real use, so a clean result means something', () => {
    // A pattern that silently matches nothing reads exactly like a clean tree.
    expect(usesWebStorage('const x = window.localStorage.getItem("k");')).toBe(true);
    expect(usesWebStorage('localStorage["k"] = "v";')).toBe(true);
    expect(usesWebStorage('sessionStorage.clear();')).toBe(true);
    expect(usesWebStorage('/** kept in `localStorage` */\n// localStorage too\nconst y = 1;')).toBe(false);
  });

  test('there are sources to check', () => {
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  test('only ui/preferences.ts uses localStorage or sessionStorage', () => {
    const users = SOURCES.filter((file) => usesWebStorage(readFileSync(file, 'utf8')));
    expect(users.map((file) => file.replaceAll('\\', '/'))).toEqual(['src/ui/preferences.ts']);
  });
});
