/**
 * The app's dashboard metrics and their fixed hues.
 *
 * Ported from `Shared/Support/Metric.swift`. Colour follows the metric
 * everywhere — KPI tiles and charts alike — so a reader can connect "blue" to
 * fuel economy across screens.
 *
 * This module deliberately resolves **no colours**. Upstream, resolving a hue
 * needs SwiftUI, so it lives in a separate `Metric+Color.swift`; keeping the two
 * apart is what lets the whole statistics layer be reasoned about without a UI
 * framework in scope. The web port has no such compilation constraint, but the
 * split is kept because the property it protects is real: a `Metric` stays a
 * plain value, and every colour decision goes through `accessiblePalette`, where
 * the contrast tests can see it.
 */

import type { AccentHue } from './accessiblePalette';

export type Metric = 'economy' | 'price' | 'spending' | 'distance';

/** Every metric, in the order the dashboard presents them. */
export const METRICS = ['economy', 'price', 'spending', 'distance'] as const;

const HUES: Record<Metric, AccentHue> = {
  economy: 'blue',
  price: 'orange',
  spending: 'purple',
  distance: 'teal',
};

/**
 * The metric's hue. Resolving it to an actual colour goes through
 * `accessiblePalette`, which picks a value meeting WCAG 2.2 AA for the current
 * scheme — a stock `orange` or `teal` is far too light against a white card to
 * be readable as text.
 */
export function hueFor(metric: Metric): AccentHue {
  return HUES[metric];
}

const NAMES: Record<Metric, string> = {
  economy: 'Fuel economy',
  price: 'Gas price',
  spending: 'Spending',
  distance: 'Distance',
};

/** Name a screen reader falls back to when a chart isn't given a specific title. */
export function accessibilityName(metric: Metric): string {
  return NAMES[metric];
}
