import { describe, expect, test } from 'vitest';
import { computeFuelStatistics } from './fuelStatistics';
import type { FuelEntryStats } from './models';
import { METRIC, US } from './units';
import { dashboardKPIs, kpiAccessibilityLabel } from './kpi';

let nextId = 0;
function entry(date: Date, odometer: number, gallons: number, price: number): FuelEntryStats {
  nextId += 1;
  return {
    id: `e${nextId}`,
    date,
    odometer,
    gallons,
    pricePerGallon: price,
    isFullTank: true,
    missedPreviousFillUp: false,
  };
}

/** Two 400-mile / 10-gallon segments: a clean 40 MPG. */
const history = [
  entry(new Date(2025, 0, 1), 10_000, 10, 3.0),
  entry(new Date(2025, 0, 11), 10_400, 10, 3.0),
  entry(new Date(2025, 0, 21), 10_800, 10, 3.0),
];

const kpisFor = (entries: FuelEntryStats[], units = US) =>
  dashboardKPIs(computeFuelStatistics(entries), units);

const byId = (entries: FuelEntryStats[], id: string, units = US) =>
  kpisFor(entries, units).find((k) => k.id === id);

describe('the KPI set', () => {
  test('has eight cards with unique, stable ids', () => {
    const kpis = kpisFor(history);
    expect(kpis).toHaveLength(8);
    expect(new Set(kpis.map((k) => k.id)).size).toBe(8);
  });

  test('ids stay identical across unit systems while titles change', () => {
    // This is what lets the list update a card in place when the reader
    // switches units, rather than tearing it down and building a new one.
    const usIds = kpisFor(history, US).map((k) => k.id);
    const metricIds = kpisFor(history, METRIC).map((k) => k.id);
    expect(metricIds).toEqual(usIds);

    expect(byId(history, 'avgEconomy', US)?.title).toBe('Avg MPG');
    expect(byId(history, 'avgEconomy', METRIC)?.title).toBe('Avg L/100km');
    expect(byId(history, 'costPerDistance', METRIC)?.title).toBe('Cost per Kilometer');
    expect(byId(history, 'totalVolume', METRIC)?.title).toBe('Total Liters');
  });

  test('formats the headline economy figure', () => {
    expect(byId(history, 'avgEconomy')?.value).toBe('40.0');
  });

  test('converts rather than relabelling when the unit inverts', () => {
    // L/100km is the reciprocal, so 40 MPG must read as a small number.
    const value = Number(byId(history, 'avgEconomy', METRIC)?.value);
    expect(value).toBeGreaterThan(5);
    expect(value).toBeLessThan(6);
  });

  test('carries details where the original does, and not elsewhere', () => {
    expect(byId(history, 'lastEconomy')?.detail).toContain('Best:');
    expect(byId(history, 'avgPrice')?.detail).toContain('Last:');
    expect(byId(history, 'totalSpent')?.detail).toContain('/mo avg');
    // Avg economy and cost-per-distance deliberately carry no secondary line.
    expect(byId(history, 'avgEconomy')?.detail).toBeNull();
    expect(byId(history, 'costPerDistance')?.detail).toBeNull();
  });

  test('every card maps to a metric the palette knows', () => {
    for (const kpi of kpisFor(history)) {
      expect(['economy', 'price', 'spending', 'distance']).toContain(kpi.metric);
    }
  });
});

describe('an empty history', () => {
  test('reports absence rather than a formatted zero', () => {
    // A new vehicle has no economy. Showing "0.0" would be a claim, not a gap.
    expect(byId([], 'avgEconomy')?.value).toBeNull();
    expect(byId([], 'lastEconomy')?.value).toBeNull();
    expect(byId([], 'costPerDistance')?.value).toBeNull();
    expect(byId([], 'avgPrice')?.value).toBeNull();
  });

  test('still reports the counts that genuinely are zero', () => {
    // Nothing spent really is nothing, unlike an undefined average.
    expect(byId([], 'fillUps')?.value).toBe('0');
    expect(byId([], 'totalSpent')?.value).toBe('$0.00');
    expect(byId([], 'totalVolume')?.value).toBe('0');
  });

  test('produces the full card set regardless', () => {
    expect(kpisFor([])).toHaveLength(8);
  });
});

describe('a single fill-up', () => {
  test('has spending but no economy yet', () => {
    const one = [entry(new Date(2025, 0, 1), 10_000, 10, 3.5)];
    expect(byId(one, 'avgEconomy')?.value).toBeNull();
    expect(byId(one, 'fillUps')?.value).toBe('1');
    expect(byId(one, 'totalSpent')?.value).toBe('$35.00');
  });
});

describe('the spoken label', () => {
  test('reads as one phrase rather than three fragments', () => {
    const kpi = byId(history, 'lastEconomy')!;
    const label = kpiAccessibilityLabel(kpi);
    expect(label.startsWith('Last MPG, ')).toBe(true);
    expect(label).toContain('Best:');
    expect(label.split(', ').length).toBeGreaterThanOrEqual(3);
  });

  test('says "no data yet" rather than leaving a gap', () => {
    expect(kpiAccessibilityLabel(byId([], 'avgEconomy')!)).toContain('no data yet');
  });

  test('omits the detail when there is none', () => {
    expect(kpiAccessibilityLabel(byId(history, 'avgEconomy')!)).toBe('Avg MPG, 40.0');
  });
});
