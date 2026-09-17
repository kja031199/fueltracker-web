/**
 * A relative time window, ported from `Shared/Support/DashboardTimeRange.swift`.
 *
 * Shared by the dashboard's range picker and the fill-up list's date filter so
 * the two cannot drift apart — upstream moved this into `Shared/` for exactly
 * that reason.
 */

export type DashboardTimeRange = '3M' | '6M' | '1Y' | 'All';

/** Every range, in picker order. The value doubles as the button label. */
export const DASHBOARD_TIME_RANGES = ['3M', '6M', '1Y', 'All'] as const;

/** Days in a given month, with `month` 1-based. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month, 0).getDate();
}

/**
 * Subtract whole months, **clamping** the day to the target month's last day.
 *
 * This is the one place a naive port goes quietly wrong. Swift's
 * `Calendar.date(byAdding: .month, value: -3, to:)` clamps: 31 May minus three
 * months is 28 February. JavaScript's `new Date(y, m - 3, d)` *rolls over*
 * instead, giving 3 March — a cutoff three days **later** than intended, which
 * silently drops the oldest days of history from a filtered list. Nothing about
 * the result looks wrong; it is just missing rows.
 *
 * The same trap applies to a leap day: 29 February minus one year rolls to
 * 1 March rather than clamping to 28 February.
 */
function subtractMonths(from: Date, months: number): Date {
  const targetMonthIndex = from.getMonth() - months;
  const year = from.getFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12; // 0-based, normalised
  const day = Math.min(from.getDate(), daysInMonth(year, month + 1));
  return new Date(
    year,
    month,
    day,
    from.getHours(),
    from.getMinutes(),
    from.getSeconds(),
    from.getMilliseconds(),
  );
}

/**
 * The earliest date this range includes, or `null` for "all time".
 *
 * `now` is an explicit argument rather than a read of the wall clock, so a
 * caller — and a test — can pin the reference point.
 */
export function cutoffFrom(range: DashboardTimeRange, now: Date = new Date()): Date | null {
  switch (range) {
    case '3M':
      return subtractMonths(now, 3);
    case '6M':
      return subtractMonths(now, 6);
    case '1Y':
      return subtractMonths(now, 12);
    case 'All':
      return null;
  }
}
