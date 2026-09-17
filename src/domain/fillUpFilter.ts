/**
 * Search and filter criteria for the fill-up list, ported from
 * `Shared/Support/FillUpFilter.swift`.
 *
 * A **pure, in-memory pass** over one vehicle's already-loaded history — not a
 * database query. That is deliberate upstream and stays true here: it only
 * narrows what the list *shows*, while statistics keep being computed over the
 * full history, so the dashboard's numbers never change with what is typed into
 * a search box.
 */

import type { FuelGrade } from './fuelGrade';
import type { DashboardTimeRange } from './dashboardTimeRange';
import { cutoffFrom } from './dashboardTimeRange';

/**
 * The fields the filter reads. Narrower than a stored entry on purpose — the
 * same trick `FuelEntryStats` uses for statistics, so a fixture is four fields
 * rather than a dozen.
 */
export interface FilterableEntry {
  readonly date: Date;
  readonly station: string;
  readonly notes: string;
  readonly fuelGrade: FuelGrade;
}

export interface FillUpFilter {
  /** Free text matched against station name and notes, case-insensitively. */
  readonly searchText: string;
  /** Only fill-ups on or after this range's cutoff. `'All'` means no limit. */
  readonly range: DashboardTimeRange;
  /** Restrict to one fuel grade, or `null` for any. */
  readonly fuelGrade: FuelGrade | null;
  /** Restrict to one station name, or `null` for any. */
  readonly station: string | null;
}

export const EMPTY_FILTER: FillUpFilter = {
  searchText: '',
  range: 'All',
  fuelGrade: null,
  station: null,
};

function trimmedSearch(filter: FillUpFilter): string {
  return filter.searchText.trim();
}

/** Whether any constraint is set — drives the "filters active" indicator. */
export function isFilterActive(filter: FillUpFilter): boolean {
  return (
    trimmedSearch(filter) !== '' ||
    filter.range !== 'All' ||
    filter.fuelGrade !== null ||
    filter.station !== null
  );
}

/**
 * Case-insensitive substring test.
 *
 * Swift uses `localizedCaseInsensitiveContains`, which folds case according to
 * the current locale. JavaScript has no `Intl` substring search, so this is the
 * closest available primitive — **not** an exact equivalent: locale-specific
 * case folding (Turkish dotless i, for instance) can differ from Foundation's.
 * Good enough for a station name or a note, and worth knowing before someone
 * assumes parity.
 */
function containsIgnoringCase(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

function matchesSearch(entry: FilterableEntry, query: string): boolean {
  if (query === '') return true;
  return containsIgnoringCase(entry.station, query) || containsIgnoringCase(entry.notes, query);
}

/**
 * The entries matching every active constraint, **preserving input order**.
 *
 * Order matters: the list hands these straight to the view, and re-sorting here
 * would silently override whatever ordering the caller chose.
 *
 * Generic over the entry type so a caller can filter richer objects — a stored
 * record carried alongside the four fields read here — and get the same type
 * back rather than having to cast its own values out again.
 */
export function applyFilter<T extends FilterableEntry>(
  filter: FillUpFilter,
  entries: readonly T[],
  now: Date = new Date(),
): T[] {
  const query = trimmedSearch(filter);
  const cutoff = cutoffFrom(filter.range, now);
  return entries.filter(
    (entry) =>
      matchesSearch(entry, query) &&
      // An unparseable date compares false against any cutoff, which excludes
      // it — the right outcome for a corrupted record, and never a throw.
      (cutoff === null || entry.date.getTime() >= cutoff.getTime()) &&
      // Exact station match, not a prefix: "Shell" must not swallow
      // "Shell #123", or two stations' histories merge into one.
      (filter.station === null || entry.station === filter.station) &&
      (filter.fuelGrade === null || entry.fuelGrade === filter.fuelGrade),
  );
}
