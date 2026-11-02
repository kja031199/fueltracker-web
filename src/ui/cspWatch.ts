/**
 * Collecting Content-Security-Policy violations, so the policy can be enforced.
 *
 * ## Why this exists in the app rather than in a snippet
 *
 * The CSP is served **report-only** (#28). The policy is good, but nothing is
 * enforced and — with no `report-to` endpoint and no server to host one —
 * nothing is collected either: violations go to the console of whoever happens
 * to have DevTools open. Enforcing it safely means running the real flows
 * against the deployed site and seeing what would have been blocked.
 *
 * That check cannot be automated from the authoring environment: the deployed
 * origin, the Firebase auth domain and the OCR CDN are all unreachable from it,
 * and signing in needs a Google account. So it is the owner's five minutes, and
 * the job of this file is to make those five minutes produce something exact
 * instead of a judgement call about console noise.
 *
 * A pasted console snippet was the first idea and it does not work well enough.
 * A `securitypolicyviolation` listener dies on navigation, and two of the five
 * flows reload the page — so it would need re-pasting each time, and it would
 * miss anything blocked *during* a load, before the paste. A listener installed
 * by the app catches the first byte of every load, and `localStorage` carries
 * the findings across the reloads.
 *
 * ## Dormant unless asked
 *
 * Nothing is recorded unless `localStorage['fueltracker.cspWatch']` is `on`.
 * A diagnostic that collects by default is one that fills somebody's storage
 * for no reason, and this one would log every blocked request forever.
 *
 * The recipe lives in `docs/csp-check.md`; from the console it is:
 *
 * ```js
 * __fuelTrackerCsp.on()       // then reload, and run the flows
 * __fuelTrackerCsp.report()   // paste this back
 * __fuelTrackerCsp.off()
 * ```
 *
 * It stays useful after #28 is closed: the next time the policy gains an
 * origin, the same three lines re-run the check.
 */

/** Set to `on` to start recording. Absent or anything else means off. */
export const CSP_WATCH_FLAG = 'fueltracker.cspWatch';

const LOG_KEY = 'fueltracker.cspViolations';

/**
 * How many *distinct* violations are kept.
 *
 * Generous: this is meant to hold everything five flows can produce. The cap
 * exists so a page that violates the policy in a loop cannot grow the entry
 * without bound — repeats of something already recorded are counted rather
 * than appended, so the cap is rarely the thing that bites.
 */
export const MAX_RECORDED_VIOLATIONS = 40;

const MAX_URI_LENGTH = 200;
const MAX_SAMPLE_LENGTH = 100;

export interface CspViolation {
  /** The directive that refused it, e.g. `connect-src`. */
  readonly directive: string;
  /** What was blocked: a URL, or `inline` / `eval` for those. */
  readonly blockedURI: string;
  /** A fragment of the offending source, when the browser provides one. */
  readonly sample: string;
  /** How many times this exact directive-and-target pair fired. */
  readonly count: number;
}

/** Anything at all into a bounded string: these fields come from an event. */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return value === undefined || value === null ? '' : String(value).slice(0, max);
  }
  // `max` bounds the result, ellipsis included — a bound that can be exceeded
  // by one is a bound somebody has to re-measure.
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Folds a violation into the list, counting repeats rather than listing them.
 *
 * Pure, so the interesting part is testable without a browser. The identity of
 * a violation is its **directive and target** — deliberately not its sample,
 * because inline-style violations carry a different sample almost every time
 * and are still one problem with one fix.
 */
export function recordViolation(
  list: readonly CspViolation[],
  next: { directive: string; blockedURI: string; sample: string },
): CspViolation[] {
  const directive = text(next.directive, 60) || 'unknown';
  const blockedURI = text(next.blockedURI, MAX_URI_LENGTH) || 'unknown';
  const sample = text(next.sample, MAX_SAMPLE_LENGTH);

  const at = list.findIndex(
    (seen) => seen.directive === directive && seen.blockedURI === blockedURI,
  );
  if (at !== -1) {
    const updated = [...list];
    const seen = updated[at]!;
    updated[at] = { ...seen, count: seen.count + 1, sample: seen.sample || sample };
    return updated;
  }

  // At the cap, a new *distinct* violation is dropped rather than evicting one
  // already recorded: the first ones are the ones with the most context around
  // them in whatever the reader was doing.
  if (list.length >= MAX_RECORDED_VIOLATIONS) return [...list];

  return [...list, { directive, blockedURI, sample, count: 1 }];
}

function isViolation(value: unknown): value is CspViolation {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['directive'] === 'string' &&
    typeof row['blockedURI'] === 'string' &&
    typeof row['sample'] === 'string' &&
    typeof row['count'] === 'number'
  );
}

/** Everything recorded so far, across reloads. Never throws. */
export function loadViolations(): CspViolation[] {
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isViolation) : [];
  } catch {
    return [];
  }
}

function save(list: readonly CspViolation[]): void {
  try {
    window.localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked. The check then only covers the current page, which is
    // worth saying in the report rather than crashing the app over.
  }
}

function watching(): boolean {
  try {
    return window.localStorage.getItem(CSP_WATCH_FLAG) === 'on';
  } catch {
    return false;
  }
}

/**
 * The text to paste back.
 *
 * "Nothing was blocked" is the hoped-for answer and the one most easily
 * mistaken for "the tool did not run", so it says so in words.
 */
export function formatReport(list: readonly CspViolation[]): string {
  if (list.length === 0) {
    return 'No CSP violations recorded. (If the watcher was armed and the flows were run, the policy is clean.)';
  }
  const events = list.reduce((total, row) => total + row.count, 0);
  const lines = list.map((row) => {
    const sample = row.sample === '' ? '' : `\n      sample: ${row.sample}`;
    return `  ${row.directive}  ×${row.count}\n      blocked: ${row.blockedURI}${sample}`;
  });
  return [
    `CSP violations: ${list.length} distinct, ${events} event(s).`,
    ...lines,
  ].join('\n');
}

/**
 * Registers the listener and the console helpers.
 *
 * Called once from `main.tsx`, before the first render, so a violation during
 * load is caught. The helpers are attached whether or not the watcher is armed
 * — they are four functions and no data, and `on()` is how it gets armed.
 */
export function installCspWatch(): void {
  if (typeof document === 'undefined') return;

  document.addEventListener('securitypolicyviolation', (event: Event) => {
    if (!watching()) return;
    const detail = event as unknown as Record<string, unknown>;
    save(
      recordViolation(loadViolations(), {
        // `effectiveDirective` is the modern field; `violatedDirective` is the
        // deprecated one some browsers still send on its own.
        directive: (detail['effectiveDirective'] ?? detail['violatedDirective']) as string,
        blockedURI: detail['blockedURI'] as string,
        sample: (detail['sample'] as string) || describeSource(detail),
      }),
    );
  });

  const helper = {
    on(): string {
      try {
        window.localStorage.setItem(CSP_WATCH_FLAG, 'on');
      } catch {
        return 'Storage is blocked in this browser, so nothing can be recorded.';
      }
      return 'CSP watcher armed. Reload, run the flows, then call __fuelTrackerCsp.report().';
    },
    off(): string {
      try {
        window.localStorage.removeItem(CSP_WATCH_FLAG);
      } catch {
        /* nothing to turn off if storage never worked */
      }
      return 'CSP watcher off. The log is kept; __fuelTrackerCsp.clear() empties it.';
    },
    report(): string {
      return formatReport(loadViolations());
    },
    clear(): string {
      save([]);
      return 'CSP log cleared.';
    },
  };

  (window as unknown as Record<string, unknown>)['__fuelTrackerCsp'] = helper;
}

/** `file:line` when the browser offers it, so an inline violation is findable. */
function describeSource(detail: Record<string, unknown>): string {
  const file = detail['sourceFile'];
  if (typeof file !== 'string' || file === '') return '';
  const line = detail['lineNumber'];
  return typeof line === 'number' && line > 0 ? `${file}:${line}` : file;
}
