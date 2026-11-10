import { beforeEach, describe, expect, test } from 'vitest';
import { makeStore, saveHasOnboarded } from '../test/fixtures';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { StubAuthProvider } from '../data/auth';
import type { PushSummary, RawSnapshot, RemoteStore } from '../data/remote';
import { App } from './App';
import { StorageErrorScreen } from './StorageErrorScreen';
import { WrongProjectScreen } from './WrongProjectScreen';
import { LinkScreen } from './LinkScreen';

/**
 * Every screen sits in the same frame (#93). Nine wrote it out, and five put
 * the title inside `<main>` while two put it outside and two had none. Now
 * each page has one title, inside the main landmark, with banners and the tab
 * bar outside it.
 */

const USER = { uid: 'frame-uid', email: 'frame@example.com', displayName: 'Frame' };

function refusing(): RemoteStore {
  return {
    async pull(): Promise<RawSnapshot> {
      const error = new Error('Missing or insufficient permissions.');
      (error as unknown as Record<string, unknown>)['code'] = 'permission-denied';
      throw error;
    },
    async push(): Promise<PushSummary> {
      return { written: 0, receiptsOmitted: 0 };
    },
  };
}

const signedIn = (): StubAuthProvider => new StubAuthProvider({ status: 'signedIn', user: USER }, USER);

/** The page's one title, and the main landmark it must sit in. */
function expectTitleInMain(name: RegExp): void {
  const titles = screen.getAllByRole('heading', { level: 1 });
  expect(titles).toHaveLength(1);
  expect(titles[0]).toHaveAccessibleName(name);
  expect(screen.getByRole('main')).toContainElement(titles[0]!);
}

beforeEach(() => localStorage.clear());

describe('one title per page, inside the main landmark', () => {
  const direct: [string, () => ReactElement][] = [
    ['storage error', () => <StorageErrorScreen detail="blocked" />],
    ['wrong project', () => <WrongProjectScreen projectId="prod" />],
    ['a fill-up link', () => <LinkScreen title="Fill-up link">body</LinkScreen>],
  ];
  test.each(direct)('%s', (_name, screenFor) => {
    render(screenFor());
    expectTitleInMain(/FuelTracker/);
  });

  test('checking the account', () => {
    render(<App store={makeStore()} auth={new StubAuthProvider({ status: 'loading' })} />);
    expectTitleInMain(/FuelTracker/);
    expect(screen.getByText(/checking your account/i)).toBeInTheDocument();
  });

  test('signing in', async () => {
    render(<App store={makeStore()} auth={new StubAuthProvider()} />);
    await screen.findByRole('heading', { name: /sign in to continue/i });
    expectTitleInMain(/FuelTracker/);
  });

  test('the first run', async () => {
    render(<App store={makeStore()} auth={signedIn()} />);
    await screen.findByRole('button', { name: /get started/i });
    expectTitleInMain(/Welcome to FuelTracker/);
  });

  test('no access', async () => {
    render(<App store={makeStore()} auth={signedIn()} remote={refusing()} />);
    await screen.findByRole('heading', { name: /does not have access/i });
    expectTitleInMain(/FuelTracker/);
  });

  test('the app itself, with the tab bar outside the main content', async () => {
    saveHasOnboarded(USER.uid);
    render(<App store={makeStore()} auth={signedIn()} />);
    const tabs = await screen.findByRole('navigation', { name: /sections/i });
    expectTitleInMain(/FuelTracker/);
    expect(screen.getByRole('main')).not.toContainElement(tabs);
  });
});
