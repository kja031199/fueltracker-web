/**
 * Whether the distance since the previous fill-up is unusually long (#66).
 *
 * Two people logging one car is exactly how a fill-up goes missing: one of
 * them fills up and forgets to log it. The next entry then spans two tanks,
 * and its MPG — computed full tank to full tank — comes out confidently wrong.
 * The existing "missed the previous fill-up" flag is the fix; this is what
 * suggests reaching for it.
 *
 * A **warning, never a block**: a long road trip between fill-ups is real.
 *
 * "Unusual" is more than `GAP_FACTOR` times the car's **median** distance
 * between fill-ups. The median, not the mean, so one earlier missed fill-up
 * in the history does not drag the usual distance up and hide the next. And
 * nothing at all until there are `MIN_GAPS` gaps to judge by — a guess from
 * two data points would cry wolf.
 */

/** How many times the usual distance counts as unusual. Strictly more than. */
export const GAP_FACTOR = 2;

/** Distances between fill-ups needed before anything is called unusual. */
export const MIN_GAPS = 3;

export interface UnusualJump {
  /** Since the previous reading. */
  readonly distance: number;
  /** The car's median distance between fill-ups. */
  readonly usual: number;
  /** The reading before this one. */
  readonly previous: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * `odometer` against the car's other readings (canonical miles), or `null`
 * when it is not unusual — or when there is not enough to say. Readings that
 * are not finite and positive are ignored rather than trusted.
 */
export function unusualOdometerJump(
  odometer: number | null,
  history: readonly number[],
): UnusualJump | null {
  return jumpFrom(odometerHistory(history), odometer);
}

/**
 * A car's readings, sorted, and the usual gap between them: the part of the
 * check that does not depend on what is being typed. Worked out once per
 * history (#88) — the form used to sort the car's whole history on every
 * keystroke. `usual` is null when there is not enough to say.
 */
export interface OdometerHistory {
  readonly readings: readonly number[];
  readonly usual: number | null;
}

export function odometerHistory(history: readonly number[]): OdometerHistory {
  const readings = [...new Set(history.filter((value) => Number.isFinite(value) && value > 0))].sort(
    (a, b) => a - b,
  );
  const gaps = readings.slice(1).map((value, index) => value - readings[index]!);
  return { readings, usual: gaps.length < MIN_GAPS ? null : median(gaps) };
}

/** `unusualOdometerJump`, against a history already worked out. */
export function jumpFrom(history: OdometerHistory, odometer: number | null): UnusualJump | null {
  if (odometer === null || !Number.isFinite(odometer) || odometer <= 0) return null;
  const { readings, usual } = history;
  if (usual === null) return null;
  // The last reading below this one: the list is sorted.
  let previous: number | null = null;
  for (const value of readings) {
    if (value >= odometer) break;
    previous = value;
  }
  if (previous === null) return null;
  const distance = odometer - previous;
  return usual > 0 && distance > GAP_FACTOR * usual ? { distance, usual, previous } : null;
}
