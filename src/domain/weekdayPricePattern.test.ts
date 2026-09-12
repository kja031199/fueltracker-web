import { describe, expect, test } from 'vitest';
import type { FuelEntryStats } from './models';
import { METRIC, US } from './units';
import {
  MIN_FILLS_FOR_INSIGHT,
  cheapestWeekday,
  firstWeekdayForLocale,
  priciestWeekday,
  weekdayPriceInsight,
  weekdayPrices,
} from './weekdayPricePattern';

// January 2025 weekday reference (1 = Sun … 7 = Sat):
//   Jan 5 Sun, Jan 6 Mon, Jan 7 Tue, Jan 8 Wed, Jan 9 Thu, Jan 10 Fri, Jan 11 Sat
// Tuesdays: 7, 14, 21, 28.  Fridays: 3, 10, 17, 24, 31.
const day = (year: number, month: number, dayOfMonth: number): Date =>
  new Date(year, month - 1, dayOfMonth);

let nextId = 0;
function makeEntry(date: Date, price: number, gallons = 10): FuelEntryStats {
  nextId += 1;
  return {
    id: `e${nextId}`,
    date,
    odometer: 10_000,
    gallons,
    pricePerGallon: price,
    isFullTank: true,
    missedPreviousFillUp: false,
  };
}

/** The four-fill Tue-cheap / Fri-dear fixture the ported suite leans on. */
const TUESDAY_CHEAPER = (): FuelEntryStats[] => [
  makeEntry(day(2025, 1, 7), 3.2), // Tue
  makeEntry(day(2025, 1, 14), 3.2), // Tue
  makeEntry(day(2025, 1, 3), 3.31), // Fri
  makeEntry(day(2025, 1, 10), 3.31), // Fri
];

describe('grouping and averaging', () => {
  test('averages price by weekday as a simple mean, not gallon-weighted', () => {
    // Two Tuesday fills, very different gallons. A gallon-weighted mean would be
    // 3.32; the simple mean is 3.20 — the price you "tend to catch", which is
    // what the pattern is about.
    const prices = weekdayPrices([
      makeEntry(day(2025, 1, 7), 3.0, 5),
      makeEntry(day(2025, 1, 14), 3.4, 20),
    ]);
    const tuesday = prices.find((p) => p.weekday === 3);
    expect(tuesday).toBeDefined();
    expect(tuesday!.averagePrice).toBeCloseTo(3.2, 4);
    expect(tuesday!.fillUpCount).toBe(2);
  });

  test('identifies the cheapest and priciest weekdays', () => {
    const entries = TUESDAY_CHEAPER();
    expect(cheapestWeekday(entries)?.weekday).toBe(3); // Tuesday
    expect(priciestWeekday(entries)?.weekday).toBe(6); // Friday
  });

  test('orders weekdays from the week first day', () => {
    // One fill on each of the seven weekdays (Jan 5–11 2025). Unlike the Swift
    // original — which computes its expectation from the platform's own
    // `firstWeekday` and so can only catch a rotation bug — these are literal.
    const entries = [5, 6, 7, 8, 9, 10, 11].map((d) => makeEntry(day(2025, 1, d), 3.0));

    expect(weekdayPrices(entries).map((p) => p.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(weekdayPrices(entries, { firstWeekday: 2 }).map((p) => p.weekday))
      .toEqual([2, 3, 4, 5, 6, 7, 1]);
    expect(weekdayPrices(entries, { firstWeekday: 7 }).map((p) => p.weekday))
      .toEqual([7, 1, 2, 3, 4, 5, 6]);
  });

  test('labels each weekday with its localised short symbol', () => {
    const prices = weekdayPrices([makeEntry(day(2025, 1, 7), 3.0)]);
    expect(prices[0]?.weekday).toBe(3);
    expect(prices[0]?.symbol).toBe('Tue');
  });
});

describe('firstWeekdayForLocale', () => {
  test('converts ISO week info into Calendar numbering', () => {
    // Intl reports firstDay as 1 = Monday … 7 = Sunday; this module uses
    // 1 = Sunday … 7 = Saturday. An off-by-one here rotates the entire week.
    expect(firstWeekdayForLocale('en-US')).toBe(1); // Sunday
    expect(firstWeekdayForLocale('en-GB')).toBe(2); // Monday
  });

  test('falls back to Sunday for a tag it cannot read', () => {
    expect(firstWeekdayForLocale('not a locale!!')).toBe(1);
    expect(firstWeekdayForLocale('')).toBe(1);
  });
});

describe('the insight headline', () => {
  test('names the cheapest and priciest days with the spread', () => {
    const insight = weekdayPriceInsight(TUESDAY_CHEAPER());
    expect(insight).not.toBeNull();
    expect(insight).toContain('Tuesday');
    expect(insight).toContain('Friday');
    expect(insight).toContain('$0.11');
    // The cheaper day is named first.
    expect(insight!.indexOf('Tuesday')).toBeLessThan(insight!.indexOf('Friday'));
  });

  test('converts the spread into the reader volume unit', () => {
    // The same 11¢/gallon gap is about 2.9¢/litre. Relabelling the unit without
    // converting the number would overstate the saving by 3.8x.
    const perGallon = weekdayPriceInsight(TUESDAY_CHEAPER(), { units: US });
    const perLitre = weekdayPriceInsight(TUESDAY_CHEAPER(), { units: METRIC });
    expect(perGallon).toContain('$0.11/gal');
    expect(perLitre).toContain('$0.03/L');
  });
});

describe('when the insight should stay silent', () => {
  test('without enough fills', () => {
    // Two fills on two weekdays: a spread exists, but too little data.
    expect(
      weekdayPriceInsight([
        makeEntry(day(2025, 1, 7), 3.2), // Tue
        makeEntry(day(2025, 1, 3), 3.31), // Fri
      ]),
    ).toBeNull();
  });

  test('one fill short of the threshold, and no longer at it', () => {
    // Pins the boundary rather than just a case comfortably on one side.
    const fills = [
      makeEntry(day(2025, 1, 7), 3.2),
      makeEntry(day(2025, 1, 14), 3.2),
      makeEntry(day(2025, 1, 3), 3.31),
      makeEntry(day(2025, 1, 10), 3.31),
    ];
    expect(fills).toHaveLength(MIN_FILLS_FOR_INSIGHT);
    expect(weekdayPriceInsight(fills.slice(0, 3))).toBeNull();
    expect(weekdayPriceInsight(fills)).not.toBeNull();
  });

  test('with a single weekday', () => {
    // Four fills, all Tuesdays — nothing to compare against.
    const entries = [7, 14, 21, 28].map((d, i) => makeEntry(day(2025, 1, d), 3.1 + i * 0.1));
    expect(weekdayPrices(entries)).toHaveLength(1);
    expect(weekdayPriceInsight(entries)).toBeNull();
  });

  test('when the spread is under one cent', () => {
    // Half-a-cent difference is noise, not a pattern.
    expect(
      weekdayPriceInsight([
        makeEntry(day(2025, 1, 7), 3.2),
        makeEntry(day(2025, 1, 14), 3.2),
        makeEntry(day(2025, 1, 3), 3.205),
        makeEntry(day(2025, 1, 10), 3.205),
      ]),
    ).toBeNull();
  });

  test('when two weekdays have identical averages', () => {
    const entries = [
      makeEntry(day(2025, 1, 7), 3.25), // Tue
      makeEntry(day(2025, 1, 14), 3.25), // Tue
      makeEntry(day(2025, 1, 3), 3.25), // Fri
      makeEntry(day(2025, 1, 10), 3.25), // Fri
    ];
    expect(weekdayPrices(entries)).toHaveLength(2);
    expect(weekdayPriceInsight(entries)).toBeNull();
  });
});

describe('degenerate and hostile input', () => {
  test('empty history has no weekday data', () => {
    expect(weekdayPrices([])).toEqual([]);
    expect(cheapestWeekday([])).toBeNull();
    expect(priciestWeekday([])).toBeNull();
    expect(weekdayPriceInsight([])).toBeNull();
  });

  test('a single fill averages to its own price', () => {
    const entries = [makeEntry(day(2025, 1, 7), 3.49)];
    const tuesday = weekdayPrices(entries)[0];
    expect(tuesday?.weekday).toBe(3);
    expect(tuesday?.averagePrice).toBeCloseTo(3.49, 4);
    expect(tuesday?.fillUpCount).toBe(1);
    expect(weekdayPriceInsight(entries)).toBeNull();
  });

  test('the pattern is independent of input order', () => {
    const entries = TUESDAY_CHEAPER();
    const arrangements = [entries, [...entries].reverse(), [entries[3]!, entries[0]!, entries[2]!, entries[1]!]];
    for (const arrangement of arrangements) {
      expect(cheapestWeekday(arrangement)?.weekday).toBe(3); // Tuesday
      expect(priciestWeekday(arrangement)?.weekday).toBe(6); // Friday
    }
  });

  test('ties resolve to the first day in the ordering, not the last', () => {
    // Swift's min(by:) and max(by:) both keep the first of equal elements, and
    // the list is already in locale order — so the tie-break is positional. A
    // reduce using <= would silently pick Friday for both.
    const entries = [
      makeEntry(day(2025, 1, 7), 3.25), // Tue
      makeEntry(day(2025, 1, 3), 3.25), // Fri
    ];
    expect(weekdayPrices(entries).map((p) => p.weekday)).toEqual([3, 6]);
    expect(cheapestWeekday(entries)?.weekday).toBe(3);
    expect(priciestWeekday(entries)?.weekday).toBe(3);
  });

  test('a non-finite price cannot produce a NaN headline', () => {
    // The one-cent guard is already false for NaN, so no filter is needed — but
    // a future refactor that reorders the guards would surface "$NaN" to a user.
    const entries = [
      makeEntry(day(2025, 1, 7), Number.NaN),
      makeEntry(day(2025, 1, 14), 3.2),
      makeEntry(day(2025, 1, 3), 3.31),
      makeEntry(day(2025, 1, 10), 3.31),
    ];
    expect(Number.isNaN(weekdayPrices(entries)[0]!.averagePrice)).toBe(true);
    expect(weekdayPriceInsight(entries)).toBeNull();
  });

  test('an infinite price cannot produce an infinite headline', () => {
    // This one found a latent bug upstream. Swift guards the spread with
    // `delta * 100 >= 1`, which is false for NaN but TRUE for +Infinity, so it
    // would render "You pay about $∞/gal less on Tuesdays than Fridays." The
    // iOS app never shows it only because FuelEntryDraft rejects non-finite
    // values at the write boundary. The port adds the finiteness check rather
    // than relying on a guard one layer away.
    const entries = [
      makeEntry(day(2025, 1, 7), 3.2),
      makeEntry(day(2025, 1, 14), 3.2),
      makeEntry(day(2025, 1, 3), Number.POSITIVE_INFINITY),
      makeEntry(day(2025, 1, 10), 3.31),
    ];
    expect(weekdayPriceInsight(entries)).toBeNull();
    // Negative infinity too, where the spread is not merely infinite but the
    // wrong sign.
    expect(
      weekdayPriceInsight([
        makeEntry(day(2025, 1, 7), Number.NEGATIVE_INFINITY),
        makeEntry(day(2025, 1, 14), 3.2),
        makeEntry(day(2025, 1, 3), 3.31),
        makeEntry(day(2025, 1, 10), 3.31),
      ]),
    ).toBeNull();
  });

  test('an invalid date drops out rather than forming a bucket', () => {
    const entries = [
      makeEntry(new Date('nonsense'), 9.99),
      makeEntry(day(2025, 1, 7), 3.2),
    ];
    const prices = weekdayPrices(entries);
    expect(prices).toHaveLength(1);
    expect(prices[0]?.weekday).toBe(3);
    expect(prices[0]?.fillUpCount).toBe(1);
  });

  test('local midnight lands on the local weekday', () => {
    // The whole module reads local time, as `monthKey` in fuelStatistics.ts
    // already does. A UTC reading would move a midnight fill a day in half the
    // world's time zones.
    const midnight = new Date(2025, 0, 7, 0, 0, 0);
    const lateEvening = new Date(2025, 0, 7, 23, 59, 59);
    expect(weekdayPrices([makeEntry(midnight, 3.0)])[0]?.weekday).toBe(3);
    expect(weekdayPrices([makeEntry(lateEvening, 3.0)])[0]?.weekday).toBe(3);
  });

  test('many fills on one day stay a single bucket', () => {
    const entries = Array.from({ length: 50 }, () => makeEntry(day(2025, 1, 7), 3.0));
    const prices = weekdayPrices(entries);
    expect(prices).toHaveLength(1);
    expect(prices[0]?.fillUpCount).toBe(50);
    expect(prices[0]?.averagePrice).toBeCloseTo(3.0, 10);
  });
});
