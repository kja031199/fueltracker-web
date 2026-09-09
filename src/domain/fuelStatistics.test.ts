import { beforeEach, describe, expect, test } from 'vitest';
import type { FuelEntryStats } from './models';
import { computeFuelStatistics } from './fuelStatistics';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

type EntryOverrides = Partial<FuelEntryStats> & { odometer: number };

/** Defaults mirror the Swift fixtures: a full tank, 10 gal at $3.50. */
const entry = (o: EntryOverrides): FuelEntryStats => ({
  id: `e${++seq}`,
  date: new Date(2026, 0, 1),
  gallons: 10,
  pricePerGallon: 3.5,
  isFullTank: true,
  missedPreviousFillUp: false,
  ...o,
});

/** A baseline plus full tanks every `miles`/`gallons`, giving exact segment MPGs. */
const chain = (odometers: readonly number[]) => odometers.map((odometer) => entry({ odometer }));

describe('empty and degenerate input', () => {
  test('empty input yields zeros and nulls, never NaN', () => {
    const s = computeFuelStatistics([]);
    expect(s.fillUpCount).toBe(0);
    expect(s.totalSpent).toBe(0);
    expect(s.totalGallons).toBe(0);
    expect(s.milesTracked).toBe(0);
    expect(s.averageMPG).toBeNull();
    expect(s.lastMPG).toBeNull();
    expect(s.bestMPG).toBeNull();
    expect(s.worstMPG).toBeNull();
    expect(s.medianMPG).toBeNull();
    expect(s.costPerMile).toBeNull();
    expect(s.averagePricePerGallon).toBeNull();
    expect(s.lastPricePerGallon).toBeNull();
    expect(s.averageMonthlySpend).toBeNull();
    expect(s.averageMilesBetweenFillUps).toBeNull();
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.monthlyTotals).toHaveLength(0);
  });

  test('a single entry has no segment and no between-fill metrics', () => {
    const s = computeFuelStatistics([entry({ odometer: 1000 })]);
    expect(s.fillUpCount).toBe(1);
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.averageMPG).toBeNull();
    expect(s.milesTracked).toBe(0);
    expect(s.averageMilesBetweenFillUps).toBeNull();
    expect(s.totalSpent).toBeCloseTo(35, 10);
  });
});

describe('the MPG segment algorithm', () => {
  test('MPG is the distance between full tanks over the closing fill', () => {
    const s = computeFuelStatistics(chain([1000, 1400]));
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.mpg).toBeCloseTo(40, 10);
    expect(s.mpgPoints[0]!.miles).toBeCloseTo(400, 10);
  });

  test('the first full tank is a baseline with no MPG of its own', () => {
    const entries = chain([1000, 1400]);
    const s = computeFuelStatistics(entries);
    expect(s.mpgFor(entries[0]!.id)).toBeNull();
    // The point is keyed to the CLOSING entry, not the baseline.
    expect(s.mpgFor(entries[1]!.id)).toBeCloseTo(40, 10);
  });

  test('partial-fill gallons roll into the next full-tank segment', () => {
    // 10 gal baseline → 4 gal partial at +200mi → 6 gal full at +200mi.
    // One point: 400 mi ÷ 10 gal = 40 MPG. The partial gets none of its own.
    const entries = [
      entry({ odometer: 1000, gallons: 10 }),
      entry({ odometer: 1200, gallons: 4, isFullTank: false }),
      entry({ odometer: 1400, gallons: 6 }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.mpg).toBeCloseTo(40, 10);
    expect(s.mpgPoints[0]!.gallons).toBeCloseTo(10, 10);
    expect(s.mpgFor(entries[1]!.id)).toBeNull();
  });

  test('an all-partial history produces no MPG at all', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000, isFullTank: false }),
      entry({ odometer: 1300, isFullTank: false }),
      entry({ odometer: 1600, isFullTank: false }),
    ]);
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.averageMPG).toBeNull();
    expect(s.totalSpent).toBeGreaterThan(0);
  });

  test('entries are sorted by ODOMETER, not date — clock skew cannot corrupt MPG', () => {
    // Dates run backwards while the odometer advances.
    const entries = [
      entry({ odometer: 1000, date: new Date(2026, 5, 1) }),
      entry({ odometer: 1400, date: new Date(2026, 4, 1) }),
      entry({ odometer: 1800, date: new Date(2026, 3, 1) }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(2);
    for (const p of s.mpgPoints) expect(p.mpg).toBeCloseTo(40, 10);
    expect(s.milesTracked).toBeCloseTo(800, 10);
  });

  test('detection and math are independent of input order', () => {
    const base = chain([1000, 1300, 1600, 1900]);
    const forward = computeFuelStatistics(base);
    const reversed = computeFuelStatistics([...base].reverse());
    const shuffled = computeFuelStatistics([base[2]!, base[0]!, base[3]!, base[1]!]);
    for (const s of [reversed, shuffled]) {
      expect(s.mpgPoints.map((p) => p.mpg)).toEqual(forward.mpgPoints.map((p) => p.mpg));
      expect(s.averageMPG).toBe(forward.averageMPG);
      expect(s.milesTracked).toBe(forward.milesTracked);
    }
  });
});

describe('segments that are skipped still advance the baseline', () => {
  test('a zero-distance segment produces no point but re-anchors', () => {
    // Duplicate odometer: miles === 0 fails the guard.
    const entries = chain([1000, 1000, 1400]);
    const s = computeFuelStatistics(entries);
    // Only one point — and it measures 400 mi from the SECOND entry, not 400
    // from the first plus a phantom zero segment.
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.miles).toBeCloseTo(400, 10);
    expect(s.mpgPoints[0]!.gallons).toBeCloseTo(10, 10);
  });

  test('a zero-gallon full tank produces no point but still advances the baseline', () => {
    const entries = [
      entry({ odometer: 1000, gallons: 10 }),
      entry({ odometer: 1400, gallons: 0 }),
      entry({ odometer: 1800, gallons: 10 }),
    ];
    const s = computeFuelStatistics(entries);
    // The zero-gallon fill closes nothing, but the next segment measures from
    // it — 400 mi, not 800.
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.miles).toBeCloseTo(400, 10);
  });

  test('duplicate odometers yield no MPG, zero miles, and no cost per mile', () => {
    const s = computeFuelStatistics(chain([1000, 1000, 1000]));
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.milesTracked).toBe(0);
    expect(s.costPerMile).toBeNull();
    expect(s.averageMilesBetweenFillUps).toBe(0);
    // Spending still counts every fill.
    expect(s.totalSpent).toBeCloseTo(105, 10);
  });

  test('negative gallons never fabricate a segment or a cost per mile', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000, gallons: 10 }),
      entry({ odometer: 1400, gallons: -10 }),
    ]);
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.averageMPG).toBeNull();
    // Post-baseline spend is negative, so cost per mile refuses.
    expect(s.costPerMile).toBeNull();
  });
});

describe('missed fill-ups break the chain', () => {
  test('a marked entry produces no segment and re-anchors the baseline', () => {
    const entries = [
      entry({ odometer: 1000 }),
      entry({ odometer: 1400, missedPreviousFillUp: true }),
      entry({ odometer: 1800 }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgFor(entries[1]!.id)).toBeNull();
    // The surviving segment runs from the marked entry, so 400 mi not 800.
    expect(s.mpgPoints[0]!.miles).toBeCloseTo(400, 10);
  });

  test('a marked PARTIAL fill clears the baseline entirely until a full tank', () => {
    const entries = [
      entry({ odometer: 1000 }),
      entry({ odometer: 1400, isFullTank: false, missedPreviousFillUp: true }),
      entry({ odometer: 1800 }),
      entry({ odometer: 2200 }),
    ];
    const s = computeFuelStatistics(entries);
    // 1800 silently re-anchors; only 1800→2200 is measurable.
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.miles).toBeCloseTo(400, 10);
  });

  test('the flag does not remove the fuel from spending totals', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000 }),
      entry({ odometer: 1400, missedPreviousFillUp: true }),
    ]);
    expect(s.totalSpent).toBeCloseTo(70, 10);
    expect(s.totalGallons).toBeCloseTo(20, 10);
    expect(s.fillUpCount).toBe(2);
  });

  test('marking every entry leaves no segments but keeps spending positive', () => {
    const s = computeFuelStatistics(
      chain([1000, 1400, 1800]).map((e) => ({ ...e, missedPreviousFillUp: true })),
    );
    expect(s.mpgPoints).toHaveLength(0);
    expect(s.averageMPG).toBeNull();
    expect(s.totalSpent).toBeGreaterThan(0);
  });

  test('the flag on the very first entry is just a baseline, harmless', () => {
    const entries = [
      { ...entry({ odometer: 1000 }), missedPreviousFillUp: true },
      entry({ odometer: 1400 }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.mpgPoints[0]!.mpg).toBeCloseTo(40, 10);
  });
});

describe('suspect-segment detection — two rules, strict > at every boundary', () => {
  test('an impossible segment among normal ones is flagged; the others are not', () => {
    // Segments 30, 30, 70 → median 30, threshold 52.5.
    const entries = chain([1000, 1300, 1600, 2300]);
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints.map((p) => Math.round(p.mpg))).toEqual([30, 30, 70]);
    expect(s.isSuspectSegment(entries[3]!.id)).toBe(true);
    expect(s.isSuspectSegment(entries[1]!.id)).toBe(false);
    expect(s.isSuspectSegment(entries[2]!.id)).toBe(false);
    // The baseline is never a suspect — it has no segment.
    expect(s.isSuspectSegment(entries[0]!.id)).toBe(false);
  });

  test('ordinary variation is never flagged', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000 }),
      entry({ odometer: 1300 }),
      entry({ odometer: 1610 }),
      entry({ odometer: 1930 }),
    ]);
    expect(s.suspectSegmentIds.size).toBe(0);
  });

  test('with only TWO segments the relative rule is off', () => {
    // 30 and 70 — a genuine highway tank could look like this.
    const entries = chain([1000, 1300, 2000]);
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(2);
    expect(s.suspectSegmentIds.size).toBe(0);
  });

  test('exactly THREE segments turns the relative rule on (inclusive boundary)', () => {
    const entries = chain([1000, 1300, 1600, 2300]);
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints).toHaveLength(3);
    expect(s.suspectSegmentIds.size).toBe(1);
  });

  test('median × 1.75 exactly is NOT flagged; a hair over is', () => {
    // Segments 40, 40, 40, 70 → upper median 40, threshold exactly 70.
    const atThreshold = computeFuelStatistics(chain([1000, 1400, 1800, 2200, 2900]));
    expect(atThreshold.mpgPoints.map((p) => Math.round(p.mpg))).toEqual([40, 40, 40, 70]);
    expect(atThreshold.suspectSegmentIds.size).toBe(0);

    const justOver = computeFuelStatistics(chain([1000, 1400, 1800, 2200, 2910]));
    expect(justOver.mpgPoints[3]!.mpg).toBeCloseTo(71, 10);
    expect(justOver.suspectSegmentIds.size).toBe(1);
  });

  test('exactly 120 MPG is NOT flagged; 120.1 is — with no history either way', () => {
    const at = computeFuelStatistics(chain([0, 1200]));
    expect(at.mpgPoints[0]!.mpg).toBeCloseTo(120, 10);
    expect(at.suspectSegmentIds.size).toBe(0);

    const over = computeFuelStatistics(chain([0, 1201]));
    expect(over.mpgPoints[0]!.mpg).toBeCloseTo(120.1, 10);
    expect(over.suspectSegmentIds.size).toBe(1);
  });

  test('the absolute cap fires without any history at all', () => {
    const s = computeFuelStatistics(chain([0, 1500]));
    expect(s.mpgPoints).toHaveLength(1);
    expect(s.suspectSegmentIds.size).toBe(1);
  });

  test('a segment tripping BOTH rules is counted once', () => {
    // 30, 30, 200 → over median×1.75 and over 120.
    const s = computeFuelStatistics(chain([1000, 1300, 1600, 3600]));
    expect(s.suspectSegmentIds.size).toBe(1);
  });

  test('multiple suspects are all flagged, ordered newest first', () => {
    const entries = [
      entry({ odometer: 1000, date: new Date(2026, 0, 1) }),
      entry({ odometer: 1300, date: new Date(2026, 0, 2) }),
      entry({ odometer: 1600, date: new Date(2026, 0, 3) }),
      entry({ odometer: 3600, date: new Date(2026, 0, 4) }),
      entry({ odometer: 5600, date: new Date(2026, 0, 5) }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.suspectSegmentIds.size).toBe(2);
    // Ordering is load-bearing: the dashboard banner shows the first.
    expect(s.suspectEntries.map((e) => e.id)).toEqual([entries[4]!.id, entries[3]!.id]);
  });

  test('marking the suspect clears the flag AND repairs the average', () => {
    const polluted = computeFuelStatistics(chain([1000, 1300, 1600, 3600]));
    const repaired = computeFuelStatistics(
      chain([1000, 1300, 1600, 3600]).map((e, i) =>
        i === 3 ? { ...e, missedPreviousFillUp: true } : e,
      ),
    );
    expect(polluted.suspectSegmentIds.size).toBe(1);
    expect(repaired.suspectSegmentIds.size).toBe(0);
    expect(repaired.averageMPG!).toBeLessThan(polluted.averageMPG!);
    expect(repaired.averageMPG!).toBeCloseTo(30, 10);
  });

  test('an entry that is not part of these statistics is never a suspect', () => {
    const s = computeFuelStatistics(chain([1000, 1300, 1600, 3600]));
    expect(s.isSuspectSegment('a-stranger-id')).toBe(false);
    expect(s.mpgFor('a-stranger-id')).toBeNull();
  });

  test('documented limitation: outliers that dominate pull the median up', () => {
    // Segments 30, 30, 66, 130 → upper median 66, threshold 115.5.
    // The 66 escapes; only the absurd one is caught.
    const entries = [
      entry({ odometer: 0 }),
      entry({ odometer: 300 }),
      entry({ odometer: 600 }),
      entry({ odometer: 1260 }),
      entry({ odometer: 2560 }),
    ];
    const s = computeFuelStatistics(entries);
    expect(s.mpgPoints.map((p) => Math.round(p.mpg))).toEqual([30, 30, 66, 130]);
    expect(s.suspectSegmentIds.size).toBe(1);
    expect(s.isSuspectSegment(entries[4]!.id)).toBe(true);
    expect(s.isSuspectSegment(entries[3]!.id)).toBe(false);
  });
});

describe('medianMPG is the UPPER median', () => {
  test('an even count takes the higher middle, not the mean of the two', () => {
    // Segments 30, 31, 32, 66 → [30,31,32,66], index 2 → 32 (not 31.5).
    const s = computeFuelStatistics([
      entry({ odometer: 0 }),
      entry({ odometer: 300 }),
      entry({ odometer: 610 }),
      entry({ odometer: 930 }),
      entry({ odometer: 1590 }),
    ]);
    expect(s.mpgPoints.map((p) => Math.round(p.mpg))).toEqual([30, 31, 32, 66]);
    expect(s.medianMPG!).toBeCloseTo(32, 10);
  });

  test('a single segment is its own median', () => {
    const s = computeFuelStatistics(chain([1000, 1400]));
    expect(s.medianMPG!).toBeCloseTo(40, 10);
  });
});

describe('the averages that are easy to get wrong', () => {
  test('averageMPG is total miles ÷ total gallons, NOT a mean of segment MPGs', () => {
    // 300 mi / 10 gal = 30, then 400 mi / 12.5 gal = 32.
    // Correct: 700 / 22.5 = 31.111…   Wrong: (30 + 32) / 2 = 31.
    const s = computeFuelStatistics([
      entry({ odometer: 0, gallons: 10 }),
      entry({ odometer: 300, gallons: 10 }),
      entry({ odometer: 700, gallons: 12.5 }),
    ]);
    expect(s.averageMPG!).toBeCloseTo(700 / 22.5, 10);
    expect(s.averageMPG!).not.toBeCloseTo(31, 5);
  });

  test('costPerMile excludes the baseline fill — that fuel predates tracking', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 0, gallons: 10, pricePerGallon: 3.6 }), // $36, excluded
      entry({ odometer: 300, gallons: 10, pricePerGallon: 3.5 }), // $35
      entry({ odometer: 700, gallons: 12.5, pricePerGallon: 4.0 }), // $50
    ]);
    expect(s.totalSpent).toBeCloseTo(121, 10);
    expect(s.milesTracked).toBeCloseTo(700, 10);
    expect(s.costPerMile!).toBeCloseTo(85 / 700, 10);
    expect(s.costPerMile!).not.toBeCloseTo(121 / 700, 6);
  });

  test('averagePricePerGallon is gallon-weighted, not a mean of prices', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 0, gallons: 5, pricePerGallon: 3.0 }),
      entry({ odometer: 300, gallons: 20, pricePerGallon: 3.4 }),
    ]);
    // (15 + 68) / 25 = 3.32, not (3.0 + 3.4) / 2 = 3.2
    expect(s.averagePricePerGallon!).toBeCloseTo(3.32, 10);
  });

  test('lastPricePerGallon is date-latest while lastMPG is odometer-latest', () => {
    const entries = [
      entry({ odometer: 0, date: new Date(2026, 0, 3), pricePerGallon: 9.99 }),
      entry({ odometer: 400, date: new Date(2026, 0, 1), pricePerGallon: 1.11 }),
      entry({ odometer: 800, date: new Date(2026, 0, 2), pricePerGallon: 2.22 }),
    ];
    const s = computeFuelStatistics(entries);
    // Latest by DATE is the odometer-first entry.
    expect(s.lastPricePerGallon).toBeCloseTo(9.99, 10);
    // Latest MPG comes from the odometer-last segment.
    expect(s.lastMPG).toBeCloseTo(s.mpgPoints[s.mpgPoints.length - 1]!.mpg, 10);
  });

  test('averageMonthlySpend needs at least a one-day span', () => {
    const hoursApart = computeFuelStatistics([
      entry({ odometer: 0, date: new Date(2026, 0, 1, 9) }),
      entry({ odometer: 300, date: new Date(2026, 0, 1, 17) }),
    ]);
    expect(hoursApart.averageMonthlySpend).toBeNull();

    const thirtyDays = computeFuelStatistics([
      entry({ odometer: 0, date: new Date(2026, 0, 1) }),
      entry({ odometer: 300, date: new Date(2026, 0, 31) }),
    ]);
    // $70 over 30 days normalises to $70 per 30 days.
    expect(thirtyDays.averageMonthlySpend!).toBeCloseTo(70, 6);
  });

  test('free fuel after the baseline yields no cost per mile', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 0, pricePerGallon: 3.5 }),
      entry({ odometer: 300, pricePerGallon: 0 }),
    ]);
    expect(s.costPerMile).toBeNull();
  });

  test('best and worst MPG span the segments', () => {
    const s = computeFuelStatistics(chain([1000, 1300, 1700, 1950]));
    expect(s.bestMPG!).toBeCloseTo(40, 10);
    expect(s.worstMPG!).toBeCloseTo(25, 10);
  });
});

describe('monthly rollups', () => {
  test('miles are the span WITHIN the month, and buckets sort across a year boundary', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000, date: new Date(2025, 11, 5) }),
      entry({ odometer: 1400, date: new Date(2025, 11, 20) }),
      entry({ odometer: 1900, date: new Date(2026, 0, 8) }),
    ]);
    expect(s.monthlyTotals).toHaveLength(2);
    expect(s.monthlyTotals[0]!.month.getFullYear()).toBe(2025);
    expect(s.monthlyTotals[1]!.month.getFullYear()).toBe(2026);
    // December spans 1000→1400; the 500 miles crossing into January are lost
    // to both buckets, by design.
    expect(s.monthlyTotals[0]!.miles).toBeCloseTo(400, 10);
    expect(s.monthlyTotals[0]!.fillUpCount).toBe(2);
    expect(s.monthlyTotals[1]!.miles).toBe(0);
  });
});

describe('series mirror their source points', () => {
  test('each series matches its points exactly', () => {
    const s = computeFuelStatistics(chain([1000, 1300, 1600]));
    expect(s.mpgSeries.map((p) => p.value)).toEqual(s.mpgPoints.map((p) => p.mpg));
    expect(s.priceSeries.map((p) => p.value)).toEqual(s.pricePoints.map((p) => p.pricePerGallon));
    expect(s.odometerSeries.map((p) => p.value)).toEqual(s.odometerPoints.map((p) => p.odometer));
  });

  test('the odometer series is ordered by DATE while price keeps odometer order', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000, date: new Date(2026, 0, 3) }),
      entry({ odometer: 1400, date: new Date(2026, 0, 1) }),
      entry({ odometer: 1800, date: new Date(2026, 0, 2) }),
    ]);
    expect(s.odometerSeries.map((p) => p.value)).toEqual([1400, 1800, 1000]);
    expect(s.priceSeries.map((p, i) => s.entries[i]!.odometer)).toEqual([1000, 1400, 1800]);
  });
});

describe('hostile magnitudes and volume', () => {
  test('enormous values stay finite', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1, gallons: 0.3, pricePerGallon: 9.999 }),
      entry({ odometer: 1_000_000_000, gallons: 60, pricePerGallon: 9.999 }),
    ]);
    expect(Number.isFinite(s.averageMPG!)).toBe(true);
    expect(Number.isFinite(s.costPerMile!)).toBe(true);
    expect(Number.isFinite(s.totalSpent)).toBe(true);
  });

  test('future-dated entries are counted, not dropped', () => {
    const s = computeFuelStatistics([
      entry({ odometer: 1000, date: new Date(2026, 0, 1) }),
      entry({ odometer: 1400, date: new Date(2030, 0, 1) }),
    ]);
    expect(s.fillUpCount).toBe(2);
    expect(s.mpgPoints).toHaveLength(1);
  });

  test('2,000 entries compute without incident', () => {
    const many = Array.from({ length: 2000 }, (_, i) => entry({ odometer: 1000 + i * 300 }));
    const s = computeFuelStatistics(many);
    expect(s.fillUpCount).toBe(2000);
    expect(s.mpgPoints).toHaveLength(1999);
    expect(Number.isFinite(s.averageMPG!)).toBe(true);
  });
});
