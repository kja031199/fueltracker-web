import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CSP_WATCH_FLAG,
  MAX_RECORDED_VIOLATIONS,
  formatReport,
  installCspWatch,
  loadViolations,
  recordViolation,
} from './cspWatch';

/**
 * The collector that makes the #28 check possible.
 *
 * The CSP is served report-only, so enforcing it needs somebody to run five
 * flows against the live site and report what was blocked. That cannot happen
 * from the authoring environment — the deployed origin, the auth domain and
 * the OCR CDN are all unreachable from it, and two flows need the owner's
 * Google account.
 *
 * A console snippet alone does not do the job: a `securitypolicyviolation`
 * listener dies on navigation, and two of the five flows reload the page — so
 * it would need re-pasting each time and would miss anything blocked *during*
 * a load, before the paste. Hence a collector in the app, dormant unless a
 * flag is set, writing to `localStorage` so it survives the reloads.
 */

function violation(over: Partial<Record<string, unknown>> = {}): Event {
  const event = new Event('securitypolicyviolation');
  Object.assign(event, {
    effectiveDirective: 'connect-src',
    blockedURI: 'https://blocked.example/thing',
    sample: '',
    sourceFile: 'https://app.example/assets/index.js',
    lineNumber: 12,
    ...over,
  });
  return event;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('recordViolation', () => {
  const one = { directive: 'connect-src', blockedURI: 'https://a.example/x', sample: '' };

  test('records the first one', () => {
    const list = recordViolation([], one);
    expect(list).toHaveLength(1);
    expect(list[0]?.directive).toBe('connect-src');
    expect(list[0]?.count).toBe(1);
  });

  test('counts a repeat rather than listing it twice', () => {
    // A blocked font or a polling request fires over and over. Fifty identical
    // lines in the report would bury the one that matters.
    let list = recordViolation([], one);
    list = recordViolation(list, one);
    list = recordViolation(list, one);
    expect(list).toHaveLength(1);
    expect(list[0]?.count).toBe(3);
  });

  test('treats a different directive or URI as a different violation', () => {
    let list = recordViolation([], one);
    list = recordViolation(list, { ...one, directive: 'script-src' });
    list = recordViolation(list, { ...one, blockedURI: 'https://b.example/y' });
    expect(list).toHaveLength(3);
  });

  test('ignores the sample when deciding what is a repeat', () => {
    // Inline-style violations carry a different sample almost every time; they
    // are still one problem with one fix.
    let list = recordViolation([], { ...one, sample: 'color: red' });
    list = recordViolation(list, { ...one, sample: 'color: blue' });
    expect(list).toHaveLength(1);
    expect(list[0]?.count).toBe(2);
  });

  test('stops adding distinct entries at the cap, but keeps counting known ones', () => {
    let list: ReturnType<typeof recordViolation> = [];
    for (let i = 0; i < MAX_RECORDED_VIOLATIONS + 10; i += 1) {
      list = recordViolation(list, { ...one, blockedURI: `https://a.example/${i}` });
    }
    expect(list).toHaveLength(MAX_RECORDED_VIOLATIONS);

    list = recordViolation(list, { ...one, blockedURI: 'https://a.example/0' });
    expect(list[0]?.count).toBe(2);
  });

  test('truncates a long URI and a long sample rather than storing a novel', () => {
    const list = recordViolation([], {
      directive: 'img-src',
      blockedURI: `data:image/png;base64,${'A'.repeat(5_000)}`,
      sample: 'x'.repeat(5_000),
    });
    expect(list[0]!.blockedURI.length).toBeLessThanOrEqual(200);
    expect(list[0]!.sample.length).toBeLessThanOrEqual(100);
  });

  test('survives fields that are not strings', () => {
    const list = recordViolation([], {
      directive: undefined as unknown as string,
      blockedURI: 7 as unknown as string,
      sample: null as unknown as string,
    });
    expect(list).toHaveLength(1);
    expect(typeof list[0]?.directive).toBe('string');
    expect(typeof list[0]?.blockedURI).toBe('string');
  });
});

describe('formatReport', () => {
  test('says plainly when there is nothing, which is the answer we hope for', () => {
    // This string is what gets pasted back, so "nothing was blocked" has to be
    // unambiguous rather than an empty box somebody has to interpret.
    expect(formatReport([])).toMatch(/no csp violations/i);
  });

  test('lists each violation with its directive, target and count', () => {
    const report = formatReport([
      { directive: 'connect-src', blockedURI: 'https://a.example/x', sample: '', count: 4 },
      { directive: 'script-src', blockedURI: 'inline', sample: 'alert(1)', count: 1 },
    ]);
    expect(report).toContain('connect-src');
    expect(report).toContain('https://a.example/x');
    expect(report).toContain('4');
    expect(report).toContain('alert(1)');
  });

  test('counts the distinct problems, not just the events', () => {
    const report = formatReport([
      { directive: 'connect-src', blockedURI: 'https://a.example/x', sample: '', count: 9 },
    ]);
    expect(report).toMatch(/1 distinct/i);
    expect(report).toMatch(/9/);
  });
});

describe('installCspWatch', () => {
  test('records nothing while the flag is off', () => {
    // The default state in production. A diagnostic that collects by default is
    // a diagnostic that fills somebody's storage for no reason.
    installCspWatch();
    document.dispatchEvent(violation());
    expect(loadViolations()).toEqual([]);
  });

  test('records once the flag is on', () => {
    localStorage.setItem(CSP_WATCH_FLAG, 'on');
    installCspWatch();
    document.dispatchEvent(violation());

    const stored = loadViolations();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.directive).toBe('connect-src');
    expect(stored[0]?.blockedURI).toBe('https://blocked.example/thing');
  });

  test('keeps what an earlier page load recorded, so a reload does not reset it', () => {
    // Two of the five flows reload the page. Losing the first half of the
    // evidence on the way would make the whole exercise pointless.
    localStorage.setItem(CSP_WATCH_FLAG, 'on');
    installCspWatch();
    document.dispatchEvent(violation({ blockedURI: 'https://first.example/' }));

    // A second load: a fresh listener over the same storage.
    installCspWatch();
    document.dispatchEvent(violation({ blockedURI: 'https://second.example/' }));

    expect(loadViolations().map((v) => v.blockedURI)).toEqual([
      'https://first.example/',
      'https://second.example/',
    ]);
  });

  test('falls back to the legacy directive field when the modern one is absent', () => {
    localStorage.setItem(CSP_WATCH_FLAG, 'on');
    installCspWatch();
    document.dispatchEvent(
      violation({ effectiveDirective: undefined, violatedDirective: 'frame-src' }),
    );
    expect(loadViolations()[0]?.directive).toBe('frame-src');
  });

  test('exposes the console helpers, which are the whole interface', () => {
    installCspWatch();
    const helper = (window as unknown as { __fuelTrackerCsp?: Record<string, unknown> })
      .__fuelTrackerCsp;
    expect(typeof helper?.on).toBe('function');
    expect(typeof helper?.off).toBe('function');
    expect(typeof helper?.report).toBe('function');
    expect(typeof helper?.clear).toBe('function');
  });

  test('on() arms it and off() disarms it', () => {
    installCspWatch();
    const helper = (window as unknown as {
      __fuelTrackerCsp: { on: () => string; off: () => string; report: () => string };
    }).__fuelTrackerCsp;

    helper.on();
    document.dispatchEvent(violation());
    expect(loadViolations()).toHaveLength(1);
    expect(helper.report()).toContain('connect-src');

    helper.off();
    document.dispatchEvent(violation({ blockedURI: 'https://after-off.example/' }));
    expect(loadViolations()).toHaveLength(1);
  });

  test('clear() empties the log without disarming', () => {
    installCspWatch();
    const helper = (window as unknown as {
      __fuelTrackerCsp: { on: () => string; clear: () => string };
    }).__fuelTrackerCsp;
    helper.on();
    document.dispatchEvent(violation());
    helper.clear();
    expect(loadViolations()).toEqual([]);

    document.dispatchEvent(violation());
    expect(loadViolations()).toHaveLength(1);
  });

  test('never throws when storage is unavailable', () => {
    // Private mode, or storage blocked. A diagnostic that takes the app down
    // is worse than no diagnostic.
    const blown = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const blownSet = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => {
      installCspWatch();
      document.dispatchEvent(violation());
    }).not.toThrow();
    expect(loadViolations()).toEqual([]);

    blown.mockRestore();
    blownSet.mockRestore();
  });

  test('survives a stored log that is not what it expects', () => {
    localStorage.setItem(CSP_WATCH_FLAG, 'on');
    localStorage.setItem('fueltracker.cspViolations', '{"not":"an array"}');
    installCspWatch();
    document.dispatchEvent(violation());
    expect(loadViolations()).toHaveLength(1);
  });
});
