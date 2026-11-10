import { beforeEach, describe, expect, test, vi } from 'vitest';
import { makeStore, saveHasOnboarded } from '../test/fixtures';
import { readFileSync } from 'node:fs';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FuelTrackerStore } from '../data/store';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { App } from './App';
import { LinkOut } from './LinkOut';
import { MetricLineChart } from './charts/MetricLineChart';
import { sourcesUnder } from '../test/imports';

/**
 * The structural accessibility gaps (#95): buttons that all say "Edit",
 * focus left on the page after a screen changed, ids that collide when a
 * component renders twice, and a chart table keyed by a label two rows can
 * share.
 */

async function setUp(tab: 'fillups' | 'vehicles' | 'dashboard' = 'fillups'): Promise<FuelTrackerStore> {
  saveHasOnboarded('local');
  const store = makeStore();
  const civic = await store.addVehicle({ name: 'Civic' });
  await store.addVehicle({ name: 'Golf' });
  for (const [i, odometer] of [10_000, 10_300].entries()) {
    const draft = makeFuelEntryDraft({
      date: new Date(2026, 0, 5 + i * 7, 9, 0),
      odometer,
      gallons: 10,
      pricePerGallon: 3.5,
      station: i === 0 ? 'Shell' : '',
    });
    if (draft === null) throw new Error('fixture draft failed validation');
    await store.addFillUp(draft, civic.id);
  }
  render(<App store={store} initialTab={tab} />);
  await screen.findByRole('navigation', { name: /sections/i });
  return store;
}

const go = async (user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> => {
  await user.click(screen.getByRole('button', { name: label }));
};

/** A button's accessible name: its label if it has one, else its text. */
const nameOf = (button: HTMLElement): string => button.getAttribute('aria-label') ?? button.textContent ?? '';

/** Every visible button's accessible name, for a uniqueness check. */
function buttonNames(): string[] {
  return screen.getAllByRole('button').map(nameOf);
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.title = 'FuelTracker';
});

describe('a repeated button says which row it is for', () => {
  test('each fill-up’s Edit and Delete name the fill-up', async () => {
    await setUp();
    const edits = await screen.findAllByRole('button', { name: /^edit the fill-up of /i });
    const deletes = screen.getAllByRole('button', { name: /^delete the fill-up of /i });
    expect(edits).toHaveLength(2);
    expect(deletes).toHaveLength(2);
    expect(new Set(edits.map(nameOf)).size).toBe(2);
    // The visible word is still the start of the name (WCAG 2.5.3, label in name).
    for (const button of [...edits, ...deletes]) expect(nameOf(button).startsWith(button.textContent ?? '')).toBe(true);
  });

  test('each car’s buttons name the car', async () => {
    await setUp('vehicles');
    for (const name of ['Civic', 'Golf']) {
      expect(screen.getByRole('button', { name: `Request a fill-up for ${name}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: `Delete ${name}` })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Select Golf' })).toBeInTheDocument();
  });

  test('no two buttons on the fill-ups or vehicles screen share a name', async () => {
    const user = userEvent.setup();
    await setUp();
    await screen.findAllByRole('button', { name: /^edit the fill-up of /i });
    const fillUps = buttonNames().filter((name) => !['Dashboard', 'Fill-ups', 'Vehicles', 'Settings'].includes(name));
    expect(new Set(fillUps).size).toBe(fillUps.length);
    await go(user, 'Vehicles');
    const vehicles = buttonNames().filter((name) => !['Dashboard', 'Fill-ups', 'Vehicles', 'Settings'].includes(name));
    expect(new Set(vehicles).size).toBe(vehicles.length);
  });
});

describe('focus follows the screen', () => {
  test('choosing a tab puts focus on the page heading, which names the tab, and titles the page', async () => {
    const user = userEvent.setup();
    await setUp('dashboard');
    await go(user, 'Vehicles');
    const heading = screen.getByRole('heading', { level: 1 });
    expect(document.activeElement).toBe(heading);
    expect(heading).toHaveAccessibleName(/Vehicles/);
    expect(document.title).toBe('Vehicles · FuelTracker');
  });

  test('the first screen is titled, but focus is not moved on arrival', async () => {
    await setUp('fillups');
    await waitFor(() => expect(document.title).toBe('Fill-ups · FuelTracker'));
    expect(document.activeElement).toBe(document.body);
  });

  test('opening the form puts focus on its heading; closing it puts focus on the list heading', async () => {
    const user = userEvent.setup();
    await setUp();
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'New fill-up' }));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /of \d+ fill-ups$/ }));
  });
});

/** An id, label target or ARIA reference written as a fixed string: "x", {'x'}, {"x"} or a template with nothing in it. */
const FIXED_ID = /(?<![\w-])(id|htmlFor|aria-labelledby|aria-describedby|aria-controls)=("[^"]*"|\{\s*(['"])[^'"]*\3\s*\}|\{\s*`[^`$]*`\s*\})/g;

describe('ids are unique however often a component renders', () => {
  test('two link panels on one page share no id', () => {
    render(
      <>
        <LinkOut url="https://example.test/#/submit/a" label="First link" />
        <LinkOut url="https://example.test/#/submit/b" label="Second link" />
      </>,
    );
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    // And each label still finds its own field.
    expect(screen.getByLabelText('First link')).toHaveValue('https://example.test/#/submit/a');
    expect(screen.getByLabelText('Second link')).toHaveValue('https://example.test/#/submit/b');
  });

  test('every tab open at once — kept alive since #93 — and still no id twice', async () => {
    const user = userEvent.setup();
    await setUp('dashboard');
    for (const tab of ['Fill-ups', 'Vehicles', 'Settings']) await go(user, tab);
    await user.click(screen.getByRole('button', { name: 'Fill-ups' }));
    await user.click(await screen.findByRole('button', { name: /log a fill-up/i }));
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(repeated).toEqual([]);
  });

  test('the fixed-id check catches every spelling of one, and passes a generated one', () => {
    const fixed = ['id="x"', "htmlFor={'x'}", 'aria-describedby={"x"}', 'aria-labelledby={`x`}', 'aria-controls="x"'];
    for (const source of fixed) expect(source.match(FIXED_ID), source).not.toBeNull();
    for (const source of ['id={`${idBase}-x`}', 'htmlFor={id}', 'aria-describedby={describedBy}', 'data-id="x"']) {
      expect(source.match(FIXED_ID), source).toBeNull();
    }
  });

  test('no component writes an id as a fixed string', () => {
    const fixed = sourcesUnder('src/ui', false)
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        [
          ...readFileSync(file, 'utf8').matchAll(FIXED_ID),
        ].map(
          (match) => `${file}: ${match[0]}`,
        ),
      );
    expect(fixed).toEqual([]);
  });
});

describe('a chart’s table of numbers', () => {
  test('two readings on the same day are two rows, with no key warning', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const day = new Date(2026, 0, 5, 9, 0);
      const later = new Date(2026, 0, 5, 18, 0);
      render(
        <MetricLineChart
          title="Price per gallon"
          points={[
            { id: 'a', date: day, value: 3.4 },
            { id: 'b', date: later, value: 3.6 },
            { id: 'c', date: new Date(2026, 0, 12), value: 3.5 },
          ]}
          metric="price"
          unit="$/gal"
          formatValue={(value) => value.toFixed(2)}
        />,
      );
      const keyWarnings = error.mock.calls.filter((call) => String(call[0]).includes('same key'));
      expect(keyWarnings).toEqual([]);
      expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
    } finally {
      error.mockRestore();
    }
  });
});
