import { describe, expect, test } from 'vitest';
import type { FuelGrade } from './fuelGrade';
import type { FilterableEntry, FillUpFilter } from './fillUpFilter';
import { EMPTY_FILTER, applyFilter, isFilterActive } from './fillUpFilter';

const day = (year: number, month: number, dayOfMonth: number): Date =>
  new Date(year, month - 1, dayOfMonth);

function entry(
  overrides: Partial<FilterableEntry> = {},
): FilterableEntry {
  return {
    date: new Date(1_700_000_000_000),
    station: '',
    notes: '',
    fuelGrade: 'Regular' as FuelGrade,
    ...overrides,
  };
}

const withFilter = (overrides: Partial<FillUpFilter>): FillUpFilter => ({
  ...EMPTY_FILTER,
  ...overrides,
});

describe('search', () => {
  const entries = [
    entry({ station: 'Shell' }),
    entry({ notes: 'topped off before road trip' }),
    entry({ station: 'Costco', notes: 'membership' }),
  ];

  test('matches station or notes, case-insensitively', () => {
    expect(applyFilter(withFilter({ searchText: 'shell' }), entries)).toHaveLength(1);
    expect(applyFilter(withFilter({ searchText: 'ROAD' }), entries)).toHaveLength(1);
    // A single letter matching several rows — Costco and "topped off".
    expect(applyFilter(withFilter({ searchText: 'o' }), entries)).toHaveLength(2);
  });

  test('whitespace-only search is inactive and matches everything', () => {
    const filter = withFilter({ searchText: '   \n' });
    expect(isFilterActive(filter)).toBe(false);
    expect(applyFilter(filter, entries)).toHaveLength(3);
  });

  test('a search that matches nothing returns empty', () => {
    expect(applyFilter(withFilter({ searchText: 'zzz-nonexistent' }), entries)).toHaveLength(0);
  });

  test('search text is trimmed before matching', () => {
    expect(applyFilter(withFilter({ searchText: '  shell  ' }), entries)).toHaveLength(1);
  });
});

describe('date range', () => {
  test('filters by cutoff relative to the supplied now', () => {
    const now = day(2025, 6, 15);
    const entries = [
      entry({ date: day(2025, 1, 1) }), // more than three months ago
      entry({ date: day(2025, 5, 1) }), // within three months
    ];
    const matched = applyFilter(withFilter({ range: '3M' }), entries, now);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.date).toEqual(day(2025, 5, 1));
  });

  test('All includes everything, including future-dated rows', () => {
    const entries = [entry({ date: day(2000, 1, 1) }), entry({ date: day(2030, 1, 1) })];
    expect(applyFilter(EMPTY_FILTER, entries, day(2025, 6, 15))).toHaveLength(2);
  });

  test('an entry exactly on the cutoff is included', () => {
    const now = day(2025, 6, 15);
    const entries = [entry({ date: day(2025, 3, 15) })];
    expect(applyFilter(withFilter({ range: '3M' }), entries, now)).toHaveLength(1);
  });
});

describe('fuel grade', () => {
  test('matches the exact grade', () => {
    const entries = [
      entry({ fuelGrade: 'Premium' }),
      entry({ fuelGrade: 'Regular' }),
      entry({ fuelGrade: 'Premium' }),
    ];
    expect(applyFilter(withFilter({ fuelGrade: 'Premium' }), entries)).toHaveLength(2);
  });

  test('catches the Other fallback', () => {
    // A record written with an unrecognised raw grade reads back as `Other`; a
    // filter for `Other` has to catch it rather than miss it silently.
    const odd = entry({ fuelGrade: 'Other', station: 'odd' });
    const matched = applyFilter(withFilter({ fuelGrade: 'Other' }), [odd, entry()]);
    expect(matched).toHaveLength(1);
    expect(matched[0]?.station).toBe('odd');
  });
});

describe('station', () => {
  test('matches exactly, not by prefix', () => {
    // "Shell" must not swallow "Shell #123" — a prefix match looks more helpful
    // and quietly merges two stations' histories into one.
    const entries = [
      entry({ station: 'Shell' }),
      entry({ station: 'Shell #123' }),
      entry({ station: 'BP' }),
    ];
    expect(applyFilter(withFilter({ station: 'Shell' }), entries)).toHaveLength(1);
  });

  test('is case-sensitive, unlike the free-text search', () => {
    const entries = [entry({ station: 'Shell' })];
    expect(applyFilter(withFilter({ station: 'shell' }), entries)).toHaveLength(0);
    expect(applyFilter(withFilter({ searchText: 'shell' }), entries)).toHaveLength(1);
  });

  test('an absent station returns empty', () => {
    expect(applyFilter(withFilter({ station: 'Chevron' }), [entry({ station: 'Shell' })]))
      .toHaveLength(0);
  });
});

describe('combining constraints', () => {
  test('every active constraint must match', () => {
    const now = day(2025, 6, 15);
    const entries = [
      entry({ date: day(2025, 5, 1), station: 'Shell', notes: 'gas', fuelGrade: 'Premium' }),
      entry({ date: day(2025, 5, 2), station: 'Shell', notes: 'gas', fuelGrade: 'Regular' }), // grade
      entry({ date: day(2025, 1, 1), station: 'Shell', notes: 'gas', fuelGrade: 'Premium' }), // range
      entry({ date: day(2025, 5, 3), station: 'BP', notes: 'gas', fuelGrade: 'Premium' }), // station
    ];
    const matched = applyFilter(
      withFilter({ range: '3M', station: 'Shell', fuelGrade: 'Premium', searchText: 'gas' }),
      entries,
      now,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.date).toEqual(day(2025, 5, 1));
  });

  test('preserves input order', () => {
    // The result goes straight to the view; re-sorting here would silently
    // override whatever ordering the caller chose.
    const dates = [day(2025, 5, 3), day(2025, 5, 2), day(2025, 5, 1)];
    const entries = dates.map((date) => entry({ date, station: 'Shell' }));
    const matched = applyFilter(withFilter({ station: 'Shell' }), entries, day(2025, 6, 15));
    expect(matched.map((e) => e.date)).toEqual(dates);
  });

  test('does not mutate the input array', () => {
    const entries = [entry({ station: 'Shell' }), entry({ station: 'BP' })];
    const before = [...entries];
    applyFilter(withFilter({ station: 'Shell' }), entries);
    expect(entries).toEqual(before);
  });
});

describe('isFilterActive', () => {
  test('reflects whether any constraint is set', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive(withFilter({ range: '1Y' }))).toBe(true);
    expect(isFilterActive(withFilter({ fuelGrade: 'Diesel' }))).toBe(true);
    expect(isFilterActive(withFilter({ station: 'Shell' }))).toBe(true);
    expect(isFilterActive(withFilter({ searchText: 'x' }))).toBe(true);
  });

  test('an explicitly empty station string still counts as a constraint', () => {
    // null means "any"; "" means "entries whose station is blank", which is a
    // real thing to ask for and must not be treated as no filter at all.
    const filter = withFilter({ station: '' });
    expect(isFilterActive(filter)).toBe(true);
    expect(applyFilter(filter, [entry({ station: '' }), entry({ station: 'Shell' })]))
      .toHaveLength(1);
  });
});

describe('hostile input', () => {
  test('an empty entry list returns empty for every constraint', () => {
    const filters = [
      EMPTY_FILTER,
      withFilter({ searchText: 'shell' }),
      withFilter({ range: '3M' }),
      withFilter({ fuelGrade: 'Premium' }),
      withFilter({ station: 'Shell' }),
    ];
    for (const filter of filters) {
      expect(applyFilter(filter, [])).toHaveLength(0);
    }
  });

  test('an invalid date is excluded by a range filter rather than throwing', () => {
    const entries = [entry({ date: new Date('nonsense'), station: 'Broken' })];
    expect(() => applyFilter(withFilter({ range: '3M' }), entries)).not.toThrow();
    expect(applyFilter(withFilter({ range: '3M' }), entries)).toHaveLength(0);
    // ...but it survives when no range is set, so the row is still reachable.
    expect(applyFilter(EMPTY_FILTER, entries)).toHaveLength(1);
  });

  test('regex-special search text is a plain substring test', () => {
    const entries = [entry({ station: 'Shell' }), entry({ station: 'A.B*C' })];
    // If the search compiled to a pattern, ".*" would match everything.
    expect(applyFilter(withFilter({ searchText: '.*' }), entries)).toHaveLength(0);
    expect(applyFilter(withFilter({ searchText: 'A.B*C' }), entries)).toHaveLength(1);
    expect(() => applyFilter(withFilter({ searchText: '[' }), entries)).not.toThrow();
  });

  test('very long search text does not throw and matches nothing', () => {
    const entries = [entry({ station: 'Shell' })];
    expect(applyFilter(withFilter({ searchText: 'x'.repeat(100_000) }), entries)).toHaveLength(0);
  });

  test('a large list filters without trouble', () => {
    const entries = Array.from({ length: 20_000 }, (_, i) =>
      entry({ station: i % 2 === 0 ? 'Shell' : 'BP' }),
    );
    expect(applyFilter(withFilter({ station: 'Shell' }), entries)).toHaveLength(10_000);
  });
});
