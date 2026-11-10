import { beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { draftWith, makeStore } from '../test/fixtures';
import type { FuelTrackerStore } from '../data/store';
import { StubAuthProvider } from '../data/auth';
import { InMemoryRemoteStore, type RawSnapshot } from '../data/remote';
import { App } from './App';
import { saveHasOnboarded } from './onboarding';

/**
 * Numbers, dates and money in the reader's own locale (#94).
 *
 * Units already followed the browser, so a German reader saw kilometres and
 * litres — next to `$`, with US number punctuation, beside dates in their own
 * format. Now one display locale, the browser's, drives numbers and dates, and
 * the currency defaults from it and can be changed in Settings. Storage is
 * canonical whatever is shown: these tests read the store back to prove it.
 */

/** 100 gallons at 12.3456: a total of exactly 1,234.56, on 1 May 2026. */
const draft = draftWith({ date: new Date(2026, 4, 1, 9, 0), odometer: 10_000, gallons: 100, pricePerGallon: 12.3456 });

function browserLanguage(language: unknown): void {
  // Restored before the next test by the config's `restoreMocks`.
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language as string);
}

async function storeWithOneFillUp(): Promise<FuelTrackerStore> {
  const store = makeStore();
  const car = await store.addVehicle({ name: 'Golf' });
  await store.addFillUp(draft(), car.id);
  return store;
}

/** The dashboard card titled `title`, by its accessible name. */
const card = (title: RegExp) => screen.findByRole('listitem', { name: title });

/** Nothing shown changed anything stored: still canonical gallons, dollars-or-whatever, miles. */
async function expectStoredUnchanged(store: FuelTrackerStore): Promise<void> {
  const [car] = await store.vehicles();
  const [row] = await store.fillUps(car!.id);
  expect(row).toMatchObject({ gallons: 100, pricePerGallon: 12.3456, odometer: 10_000 });
}

beforeEach(() => {
  localStorage.clear();
  saveHasOnboarded('local');
});

describe('a German browser (#94)', () => {
  test('shows euros and German numbers on the dashboard, and stores nothing differently', async () => {
    browserLanguage('de-DE');
    const store = await storeWithOneFillUp();
    render(<App store={store} initialTab="dashboard" />);

    expect(await card(/^Total Spent/)).toHaveAccessibleName(/1\.234,56 €/);
    // Litres, because units follow the browser too — now with a decimal comma.
    expect(await card(/^Total Liters/)).toHaveAccessibleName(/378,541/);
    await expectStoredUnchanged(store);
  });

  test('dates use the same locale as the numbers beside them', async () => {
    browserLanguage('de-DE');
    const store = await storeWithOneFillUp();
    render(<App store={store} initialTab="fillups" />);
    const row = (await screen.findByText('1.5.2026')).closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/^1\.234,56\s€$/)).toBeInTheDocument();
    expect(within(row!).getByText(/378,541 L/)).toBeInTheDocument();
  });
});

describe('sync notes (#94)', () => {
  /** An account holding 1,200 rows no fill-up could be built from. */
  class GarbageRemote extends InMemoryRemoteStore {
    override async pull(): Promise<RawSnapshot> {
      const real = await super.pull();
      return { ...real, fillUps: Array.from({ length: 1_200 }, (_, i) => ({ id: `bad-${i}`, gallons: 'lots' })) };
    }
  }

  test('are counted in the reader’s locale', async () => {
    browserLanguage('de-DE');
    const user = { uid: 'u1', email: 'driver@example.com', displayName: 'Driver' };
    saveHasOnboarded(user.uid);
    render(
      <App
        store={makeStore()}
        auth={new StubAuthProvider({ status: 'signedIn', user }, user)}
        remote={new GarbageRemote()}
        initialTab="settings"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('1.200 rows from your account were unusable and skipped'),
    );
  });
});

describe('the currency setting', () => {
  test('is picked in Settings, changes only what is shown, and survives a reload', async () => {
    browserLanguage('de-DE');
    const store = await storeWithOneFillUp();
    const user = userEvent.setup();
    render(<App store={store} initialTab="settings" />);

    const picker = await screen.findByLabelText('Currency');
    expect(picker).toHaveValue('EUR');
    expect(picker).toHaveAccessibleDescription(/not converted/i);
    await user.selectOptions(picker, 'GBP');
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await card(/^Total Spent/)).toHaveAccessibleName(/1\.234,56 £/);
    await expectStoredUnchanged(store);

    cleanup();
    window.history.replaceState(null, '', '/');
    render(<App store={store} initialTab="dashboard" />);
    expect(await card(/^Total Spent/)).toHaveAccessibleName(/1\.234,56 £/);
  });

  test('an American browser sees what it always did', async () => {
    browserLanguage('en-US');
    const store = await storeWithOneFillUp();
    render(<App store={store} initialTab="dashboard" />);
    expect(await card(/^Total Spent/)).toHaveAccessibleName(/\$1,234\.56/);
  });
});

describe('hostile settings and browsers fall back rather than break the app', () => {
  test.each([
    ['two letters', 'XX'],
    ['lower case', 'eur'],
    ['markup', '<script>'],
    ['10 KB of text', 'x'.repeat(10_000)],
    ['a number', 42],
    ['null', null],
  ] as const)(
    'a stored currency that is %s is ignored for the locale’s own',
    async (_label, stored) => {
      browserLanguage('de-DE');
      localStorage.setItem('fueltracker.currency', JSON.stringify(stored));
      const store = await storeWithOneFillUp();
      render(<App store={store} initialTab="dashboard" />);
      expect(await card(/^Total Spent/)).toHaveAccessibleName(/1\.234,56 €/);
    },
  );

  test.each(['', '!!!', undefined])('a browser language of %s reads as US English', async (language) => {
    browserLanguage(language);
    const store = await storeWithOneFillUp();
    render(<App store={store} initialTab="dashboard" />);
    expect(await card(/^Total Spent/)).toHaveAccessibleName(/\$1,234\.56/);
  });
});
