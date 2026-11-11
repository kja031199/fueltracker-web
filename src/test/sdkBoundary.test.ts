import { describe, expect, test } from 'vitest';
import { importsOf, sourcesUnder } from './imports';

/**
 * The Firebase SDK is used only under `src/data/firebase/` (invariant 6).
 *
 * Everything else talks to the cloud through the `RemoteStore`,
 * `AuthProvider` and sharing interfaces, which is what lets the tests run on
 * the in-memory remotes and the app start without Firebase configured. It was
 * a rule in the docs with nothing checking it (#93). Production files only:
 * a test is free to name the SDK in a fixture.
 */

const FIREBASE = /^(firebase|@firebase\/[^/]+)(\/|$)/;
const HOME = 'src/data/firebase/';

export function sdkOutsideItsHome(file: string, imports: readonly string[]): string[] {
  return file.startsWith(HOME) ? [] : imports.filter((path) => FIREBASE.test(path));
}

// `src/test/` is test support — the shared fixtures, the emulator setup — and
// not shipped, though its files are not named `.test.ts` (#97).
const PRODUCTION = sourcesUnder('src', false).filter((file) => !file.startsWith('src/test/'));

describe('the Firebase SDK stays in data/firebase', () => {
  test('the rule catches the SDK by any entry point, and only outside its home', () => {
    expect(sdkOutsideItsHome('src/ui/App.tsx', ['firebase/firestore', 'firebase', '@firebase/auth', 'react'])).toEqual([
      'firebase/firestore',
      'firebase',
      '@firebase/auth',
    ]);
    expect(sdkOutsideItsHome('src/data/firebase/remoteStore.ts', ['firebase/firestore'])).toEqual([]);
    expect(sdkOutsideItsHome('src/data/firebaseish.ts', ['firebase/app'])).toEqual(['firebase/app']);
    expect(sdkOutsideItsHome('src/ui/App.tsx', ['firebasex', 'src/data/firebase/settings'])).toEqual([]);
  });

  test('there are files on both sides of the line', () => {
    expect(PRODUCTION.filter((file) => file.startsWith(HOME)).length).toBeGreaterThan(3);
    expect(PRODUCTION.filter((file) => !file.startsWith(HOME)).length).toBeGreaterThan(50);
  });

  test.each(PRODUCTION)('%s', (file) => {
    expect(sdkOutsideItsHome(file, importsOf(file))).toEqual([]);
  });
});
