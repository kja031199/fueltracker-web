import { describe, expect, test } from 'vitest';
import { computeFuelStatistics } from './fuelStatistics';
import type { FuelEntryStats } from './models';
import { KPI_IDS, dashboardKPIs } from './kpi';

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

const kpisFor = (entries: FuelEntryStats[]) => dashboardKPIs(computeFuelStatistics(entries));

const byId = (entries: FuelEntryStats[], id: string) => kpisFor(entries).find((k) => k.id === id);

describe('the KPI set: values, not words (#94)', () => {
  test('has eight cards, in the order of KPI_IDS', () => {
    expect(kpisFor(history).map((k) => k.id)).toEqual([...KPI_IDS]);
  });

  test('carries canonical numbers, never formatted text', () => {
    expect(byId(history, 'avgEconomy')?.value).toBe(40);
    expect(byId(history, 'totalSpent')?.value).toBe(90);
    expect(byId(history, 'distanceTracked')?.value).toBe(800);
    expect(byId(history, 'fillUps')?.value).toBe(3);
    expect(byId(history, 'totalVolume')?.value).toBe(30);
    for (const kpi of kpisFor(history)) expect(typeof kpi.value === 'number' || kpi.value === null).toBe(true);
  });

  test('says what each secondary line is about, with its value', () => {
    expect(byId(history, 'lastEconomy')?.detail).toEqual({ kind: 'bestEconomy', mpg: 40 });
    expect(byId(history, 'avgPrice')?.detail).toEqual({ kind: 'lastPrice', pricePerGallon: 3 });
    expect(byId(history, 'totalSpent')?.detail?.kind).toBe('monthlySpend');
    expect(byId(history, 'distanceTracked')?.detail).toEqual({ kind: 'milesPerFill', miles: 400 });
    expect(byId(history, 'fillUps')?.detail).toEqual({ kind: 'gallonsPerFill', gallons: 10 });
    expect(byId(history, 'totalVolume')?.detail).toEqual({ kind: 'costPerFill', amount: 30 });
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
  test('reports absence rather than a zero', () => {
    expect(byId([], 'avgEconomy')?.value).toBeNull();
    expect(byId([], 'lastEconomy')?.value).toBeNull();
    expect(byId([], 'costPerDistance')?.value).toBeNull();
    expect(byId([], 'avgPrice')?.value).toBeNull();
  });

  test('still reports the counts that genuinely are zero', () => {
    expect(byId([], 'fillUps')?.value).toBe(0);
    expect(byId([], 'totalSpent')?.value).toBe(0);
    expect(byId([], 'totalVolume')?.value).toBe(0);
    expect(kpisFor([])).toHaveLength(8);
  });
});
