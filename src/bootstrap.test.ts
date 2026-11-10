import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { boot, type BootDeps, type AppProps, type RemoteFactory } from './bootstrap';
import { StubAuthProvider, type AuthState, type AuthUser } from './data/auth';
import type { AccountStore } from './data/accountStore';
import { InMemoryRemoteStore } from './data/testing/inMemoryRemote';
import { InMemorySharingWorld } from './data/testing/inMemorySharing';
import { makeStore } from './test/fixtures';

/**
 * Starting the app (#90).
 *
 * `main.tsx` used to await the auth, Firestore and sharing modules together
 * before rendering anything, so every cold start — the sign-in screen
 * included, which needs only auth — showed a blank page while about 170 KB
 * gzipped of Firebase downloaded, parsed and ran. `boot` renders a shell at
 * once, loads auth, and loads the Firestore modules only once somebody is
 * signed in. The loaders are passed in, so the order is testable without a
 * browser or a network.
 */

const KYLE: AuthUser = { uid: 'kyle', email: 'kyle@example.com', displayName: 'Kyle', emailVerified: true };
const SAM: AuthUser = { uid: 'sam', email: 'sam@example.com', displayName: 'Sam', emailVerified: true };

/** A promise and its resolver, so a test decides when a module "arrives". */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function account(uid: string): AccountStore & { closed: boolean } {
  const made = {
    store: makeStore({ author: uid }),
    syncState: { load: async () => null, save: async () => {} } as unknown as AccountStore['syncState'],
    sharingState: {} as AccountStore['sharingState'],
    databaseName: `fueltracker-${uid}`,
    closed: false,
    close() {
      made.closed = true;
    },
  };
  return made;
}

const factory: RemoteFactory = (uid, user) => ({
  remote: new InMemoryRemoteStore(),
  sharingRemote: new InMemorySharingWorld().sharingFor({
    uid,
    name: user.displayName,
    email: user.email,
    emailVerified: user.emailVerified === true,
  }),
});

interface Harness {
  readonly deps: BootDeps;
  readonly log: string[];
  readonly renders: AppProps[];
  readonly auth: StubAuthProvider;
  readonly loadAuth: ReturnType<typeof deferred<StubAuthProvider>>;
  readonly loadRemotes: ReturnType<typeof vi.fn<() => Promise<RemoteFactory>>>;
  readonly opened: Map<string, AccountStore & { closed: boolean }>;
  readonly released: ReturnType<typeof vi.fn<() => void>>;
}

function harness(initial: AuthState = { status: 'signedOut', error: null }, user: AuthUser = KYLE): Harness {
  const log: string[] = [];
  const renders: AppProps[] = [];
  const auth = new StubAuthProvider(initial, user);
  const loadAuth = deferred<StubAuthProvider>();
  const opened = new Map<string, AccountStore & { closed: boolean }>();
  const loadRemotes = vi.fn(async () => {
    log.push('remotes requested');
    return factory;
  });
  const released = vi.fn(() => {
    log.push('account resources released');
  });
  const deps: BootDeps = {
    loadAuth: () => {
      log.push('auth requested');
      return loadAuth.promise;
    },
    loadRemotes,
    openAccount: async (uid) => {
      log.push(`open ${uid}`);
      const made = account(uid);
      opened.set(uid, made);
      return made;
    },
    view: {
      opening: () => log.push('opening shell'),
      app: (props) => {
        renders.push(props);
        log.push(props.remote === null ? `app ${props.auth.state().status}, local only` : 'app with sync');
      },
    },
    onAccountClosed: released,
  };
  return { deps, log, renders, auth, loadAuth, loadRemotes, opened, released };
}

/** Lets every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the first paint does not wait for Firebase', () => {
  test('a shell is on screen before the auth module has even arrived', async () => {
    const h = harness();
    void boot(h.deps);
    await settle();
    expect(h.log).toEqual(['opening shell', 'auth requested']);
  });

  test('the sign-in screen renders without the Firestore modules being requested', async () => {
    const h = harness();
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    expect(h.log).toEqual(['opening shell', 'auth requested', 'app signedOut, local only']);
    expect(h.loadRemotes).not.toHaveBeenCalled();
  });

  test('signing in is what loads them — once, alongside opening the database', async () => {
    const h = harness();
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    await h.auth.signIn();
    await settle();
    expect(h.log.slice(3)).toEqual(['opening shell', 'open kyle', 'remotes requested', 'app with sync']);

    // A token refresh, a sign-out and back in: the modules are not fetched again.
    await h.auth.signOut();
    await h.auth.signIn();
    await settle();
    expect(h.loadRemotes).toHaveBeenCalledTimes(1);
  });

  test('a returning, signed-in reader gets their log with sync, as before', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    const last = h.renders.at(-1);
    expect(last?.remote).not.toBeNull();
    expect(last?.store).toBe(h.opened.get('kyle')?.store);
    expect(last?.sharing?.remote).toBeDefined();
  });
});

describe('when the Firestore modules cannot be loaded', () => {
  test('the log opens locally, without sync, rather than not at all', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    h.loadRemotes.mockRejectedValueOnce(new Error('offline, and not cached'));
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    const last = h.renders.at(-1);
    expect(last?.store).toBe(h.opened.get('kyle')?.store);
    expect(last?.remote).toBeNull();
  });

  test('and the next auth event tries again', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    h.loadRemotes.mockRejectedValueOnce(new Error('offline, and not cached'));
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    await h.auth.signOut();
    await h.auth.signIn();
    await settle();
    expect(h.loadRemotes).toHaveBeenCalledTimes(2);
    expect(h.renders.at(-1)?.remote).not.toBeNull();
  });
  test('a token refresh for the same account tries again too, without signing out', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    h.loadRemotes.mockRejectedValueOnce(new Error('offline, and not cached'));
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    expect(h.renders.at(-1)?.remote).toBeNull();
    // `onAuthStateChanged` fires again for the same user on a token refresh.
    await h.auth.signIn();
    await settle();
    expect(h.loadRemotes).toHaveBeenCalledTimes(2);
    expect(h.renders.at(-1)?.remote).not.toBeNull();
  });
});

describe('accounts change as before', () => {
  test('signing out closes the database and releases what the session held', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    await h.auth.signOut();
    await settle();
    expect(h.opened.get('kyle')?.closed).toBe(true);
    expect(h.released).toHaveBeenCalledTimes(1);
    expect(h.renders.at(-1)?.remote).toBeNull();
  });

  test('a token refresh for the same account reuses everything', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    const first = h.renders.at(-1);
    await h.auth.signIn();
    await settle();
    const second = h.renders.at(-1);
    expect(second?.store).toBe(first?.store);
    expect(second?.remote).toBe(first?.remote);
    expect(h.opened.size).toBe(1);
    expect(h.released).not.toHaveBeenCalled();
  });

  test('a different account closes the first and opens its own', async () => {
    const h = harness({ status: 'signedIn', user: KYLE });
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    // Swap accounts in one event, the way a second Google account would.
    (h.auth as unknown as { set(state: AuthState): void }).set({ status: 'signedIn', user: SAM });
    await settle();
    expect(h.opened.get('kyle')?.closed).toBe(true);
    expect(h.released).toHaveBeenCalledTimes(1);
    expect(h.renders.at(-1)?.store).toBe(h.opened.get('sam')?.store);
  });

  test('an account overtaken while its database was opening is closed, not shown', async () => {
    const h = harness();
    const slow = deferred<AccountStore & { closed: boolean }>();
    const kyle = account('kyle');
    h.deps.openAccount = async (uid) => {
      if (uid === 'kyle') return slow.promise;
      const made = account(uid);
      h.opened.set(uid, made);
      return made;
    };
    void boot(h.deps);
    h.loadAuth.resolve(h.auth);
    await settle();
    await h.auth.signIn();
    await settle();
    await h.auth.signOut();
    slow.resolve(kyle);
    await settle();
    expect(kyle.closed).toBe(true);
    expect(h.renders.at(-1)?.remote).toBeNull();
    expect(h.renders.some((props) => props.store === kyle.store)).toBe(false);
  });
});

describe('main.tsx hands boot the real modules, in the same places (#90)', () => {
  // The tests above prove the order for whatever loaders they are given; this
  // holds main.tsx to giving the Firestore modules only to `loadRemotes`.
  const main = readFileSync('src/main.tsx', 'utf8');
  const section = (from: string, to: string): string => {
    const start = main.indexOf(from);
    const end = main.indexOf(to, start);
    expect(start, from).toBeGreaterThan(-1);
    expect(end, to).toBeGreaterThan(start);
    return main.slice(start, end);
  };

  test('auth is the only Firebase module loadAuth imports', () => {
    const loadAuth = section('loadAuth:', 'loadRemotes:');
    expect(loadAuth).toContain("import('./data/firebase/authProvider')");
    expect(loadAuth).not.toMatch(/remoteStore|sharingRemote/);
  });

  test('the Firestore modules are imported in loadRemotes and nowhere else', () => {
    const loadRemotes = section('loadRemotes:', 'openAccount:');
    expect(loadRemotes).toContain("import('./data/firebase/remoteStore')");
    expect(loadRemotes).toContain("import('./data/firebase/sharingRemote')");
    for (const module of ['remoteStore', 'sharingRemote']) {
      expect(main.split(`data/firebase/${module}`).length - 1, module).toBe(1);
    }
  });

  test('no Firebase module is imported statically, apart from the settings', () => {
    const statics = [...main.matchAll(/^import [^;]*from '([^']+)';/gm)].map(([, from]) => from);
    expect(statics.filter((from) => from?.includes('firebase/'))).toEqual(['./data/firebase/settings']);
  });
});
