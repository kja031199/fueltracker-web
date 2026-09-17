/**
 * A vehicle with six months of realistic history, ported from
 * `Shared/Support/PreviewData.swift`.
 *
 * Upstream this fills a SwiftUI preview container. Here it does double duty: it
 * is what a "try it without typing anything" demo loads, and it is a ready-made
 * fixture for tests that need a plausible history rather than three hand-built
 * rows.
 *
 * ## Deterministic, unlike the original
 *
 * The Swift version calls `Double.random` and `randomElement`, so every preview
 * differs. That is fine for eyeballing a layout and wrong for anything else: a
 * demo that shows different numbers on every visit is confusing, and a fixture
 * that changes between runs turns a real regression into a flake. The tiny
 * generator below is seeded, so the same call always produces the same twelve
 * fill-ups — while still looking like scattered real-world data rather than a
 * neat arithmetic series.
 *
 * Every entry is still built through `makeFuelEntryDraft` and written with
 * `addFillUp`. Demo data is data; it does not get a private path into storage.
 */

import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import type { FuelTrackerStore } from './store';

/**
 * A small deterministic generator (mulberry32). Not cryptographic and not
 * trying to be — it only has to be repeatable and unpatterned to the eye.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICES = [
  3.199, 3.249, 3.399, 3.359, 3.289, 3.459,
  3.599, 3.549, 3.479, 3.389, 3.299, 3.349,
];

const STATIONS = ['Shell', 'Costco', 'Chevron', '76'];

const DAY_MS = 86_400_000;

export interface DemoDataOptions {
  /** Anchors the history so it ends near "today". Defaults to the real clock. */
  readonly now?: Date;
  /** Change to get a different but equally repeatable history. */
  readonly seed?: number;
}

/**
 * Seeds `store` with one vehicle and twelve fill-ups spanning about six months,
 * and returns the vehicle's id.
 *
 * Roughly 30–36 MPG across 280–360 mile tanks, which is what makes the
 * dashboard's charts and the suspect-segment detection look like they are
 * describing a real car.
 */
export async function seedDemoData(
  store: FuelTrackerStore,
  options: DemoDataOptions = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const random = seededRandom(options.seed ?? 20_250_101);
  const between = (min: number, max: number): number => min + random() * (max - min);

  const vehicle = await store.addVehicle({
    name: 'Daily Driver',
    make: 'Honda',
    model: 'Civic',
    year: 2021,
  });

  let odometer = 42_150;
  let date = new Date(now.getTime() - 180 * DAY_MS);

  for (const [index, price] of PRICES.entries()) {
    const miles = between(280, 360);
    const gallons = miles / between(30, 36);
    // The first fill is the baseline: it has no preceding segment, so the
    // odometer does not advance before it.
    if (index > 0) odometer += miles;

    const draft = makeFuelEntryDraft({
      date,
      odometer: Math.round(odometer),
      gallons: Math.round(gallons * 1000) / 1000,
      pricePerGallon: price,
      isFullTank: true,
      fuelGrade: 'Regular',
      station: STATIONS[Math.floor(random() * STATIONS.length)] ?? 'Shell',
    });
    // Unreachable with these inputs, but the draft is the gate and the gate is
    // not bypassed for seed data.
    if (draft !== null) await store.addFillUp(draft, vehicle.id);

    date = new Date(date.getTime() + 15 * DAY_MS);
  }

  return vehicle.id;
}
