import { describe, expect, test } from 'vitest';
import type { OdometerCandidate } from './odometerScanParser';
import {
  DEFAULT_MILES_PER_FILL,
  isWarning,
  parseOdometer,
  preferredOdometer,
} from './odometerScanParser';

describe('picking the right number off a cluttered dashboard', () => {
  test('picks the history-consistent value among distractors', () => {
    // A real cluster: clock, temperature, trip meter, speed — and the odometer.
    const candidate = parseOdometer(['12:45', '72°F', 'TRIP A 234.5', '0 MPH', '42460'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(42_460);
    expect(candidate?.validation).toEqual({ kind: 'plausible', milesSinceLast: 310 });
  });

  test('clock readouts never become candidates', () => {
    // "12:45" must not be read as 1245 — even when it is the only number.
    expect(
      parseOdometer(['12:45'], { previousOdometer: 1_000, typicalMilesPerFill: 300 }),
    ).toBeNull();
  });

  test('temperature and percentage readouts are ignored', () => {
    expect(parseOdometer(['72°F', '80%'])).toBeNull();
    expect(parseOdometer(['21°C', '15 %'])).toBeNull();
  });

  test('comma-grouped odometers parse', () => {
    const candidate = parseOdometer(['42,460'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(42_460);
  });

  test('an integer odometer beats a decimal trip meter when both fit', () => {
    const candidate = parseOdometer(['TRIP 42250.5', '42460'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(42_460);
  });

  test('typical distance guides the choice between feasible values', () => {
    // Two feasible integers: expected ≈ 42,470 picks the closer one.
    const candidate = parseOdometer(['42460', '43900'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(42_460);
  });

  test('a trip meter is still used when nothing else fits', () => {
    // Integers are preferred, not required — a one-decimal value in the window
    // beats returning nothing.
    const candidate = parseOdometer(['42460.5'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(42_460.5);
    expect(candidate?.validation.kind).toBe('plausible');
  });
});

describe('history validation verdicts', () => {
  test('a reading below the last one is flagged, not hidden', () => {
    const candidate = parseOdometer(['41000'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.value).toBe(41_000);
    expect(candidate?.validation).toEqual({ kind: 'belowLastReading', last: 42_150 });
    expect(isWarning(candidate!.validation)).toBe(true);
  });

  test('a reading implausibly far ahead is flagged', () => {
    // 424,600 — a misread with an extra digit — is ~382k miles ahead.
    const candidate = parseOdometer(['424600'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.validation).toEqual({
      kind: 'implausiblyFar',
      last: 42_150,
      miles: 382_450,
    });
    expect(isWarning(candidate!.validation)).toBe(true);
  });

  test('no history picks the largest plausible number', () => {
    const candidate = parseOdometer(['234.5', '42460']);
    expect(candidate?.value).toBe(42_460);
    expect(candidate?.validation).toEqual({ kind: 'noHistory' });
    expect(isWarning(candidate!.validation)).toBe(false);
  });

  test('the same reading as the last fill is plausible, at zero miles', () => {
    // Filling twice without driving — topping off — is legal.
    const candidate = parseOdometer(['42150'], {
      previousOdometer: 42_150,
      typicalMilesPerFill: 320,
    });
    expect(candidate?.validation).toEqual({ kind: 'plausible', milesSinceLast: 0 });
  });

  test('a missing typical distance falls back to a default window', () => {
    // One prior fill means no average yet; a ~300-mile jump must still validate.
    const candidate = parseOdometer(['42460'], { previousOdometer: 42_150 });
    expect(candidate?.validation).toEqual({ kind: 'plausible', milesSinceLast: 310 });
    expect(DEFAULT_MILES_PER_FILL).toBe(350);
  });

  test('the feasible window has a floor of 3,000 miles', () => {
    // With a short typical distance, 8× would be a very tight window; the floor
    // keeps a long trip from being flagged as a misread.
    const candidate = parseOdometer(['12500'], {
      previousOdometer: 10_000,
      typicalMilesPerFill: 100,
    });
    expect(candidate?.validation.kind).toBe('plausible');
  });
});

describe('hostile input', () => {
  test('excluded pump values are never chosen', () => {
    // On a pump photo, the gallons/price/total already claimed by the pump
    // parser must not be re-read as a mileage figure.
    expect(
      parseOdometer(['30.48', '8.712', '3.499'], { excluding: [30.48, 8.712, 3.499] }),
    ).toBeNull();
  });

  test('multi-decimal numbers are never candidates, even without exclusions', () => {
    // Regression: "3.499" once split into "3.4" plus a phantom "99" that became
    // a 99-mile odometer candidate. Two or more decimals are pump formatting
    // and must be consumed whole, then discarded.
    expect(parseOdometer(['30.48', '8.712', '3.499'])).toBeNull();
  });

  test('the phantom-tail regression is pinned directly', () => {
    // Belt and braces on the same bug: a three-decimal value whose tail would
    // land inside the plausible range if it leaked.
    expect(parseOdometer(['1.999'])).toBeNull();
    expect(parseOdometer(['0.4250'])).toBeNull();
  });

  test('seven-digit and tiny numbers are out of range', () => {
    expect(parseOdometer(['1000000'])).toBeNull();
    expect(parseOdometer(['5'])).toBeNull();
  });

  test('empty and garbage input produce null', () => {
    expect(parseOdometer([], { previousOdometer: 1_000, typicalMilesPerFill: 300 })).toBeNull();
    expect(
      parseOdometer(['ODO', 'MILES', 'P R N D'], {
        previousOdometer: 1_000,
        typicalMilesPerFill: 300,
      }),
    ).toBeNull();
  });

  test('exclusion matching tolerates floating-point drift', () => {
    // The pump parser's value and the odometer scan's may differ in the last
    // bit; the comparison is a tolerance, not equality.
    expect(parseOdometer(['42460'], { excluding: [42_460.0005] })).toBeNull();
    // ...but a genuinely different number is still a candidate.
    expect(parseOdometer(['42460'], { excluding: [42_461] })?.value).toBe(42_460);
  });

  test('a very long line does not throw', () => {
    const long = Array.from({ length: 5000 }, (_, i) => `${40_000 + i}`).join(' ');
    expect(() => parseOdometer([long])).not.toThrow();
    expect(parseOdometer([long])?.value).toBe(44_999);
  });

  test('non-ASCII and emoji text matches nothing', () => {
    expect(parseOdometer(['ОДОМЕТР', '走行距離', '🚗'])).toBeNull();
  });

  test('a negative-looking reading is read as its magnitude, then ranged', () => {
    // The minus sign is not part of the pattern, so "-42460" yields 42460 —
    // which is the right outcome for OCR noise around a real number.
    expect(parseOdometer(['-42460'])?.value).toBe(42_460);
  });
});

describe('frame-to-frame preference for live scanning', () => {
  const plausible: OdometerCandidate = {
    value: 42_460,
    validation: { kind: 'plausible', milesSinceLast: 310 },
  };
  const warning: OdometerCandidate = {
    value: 41_000,
    validation: { kind: 'belowLastReading', last: 42_150 },
  };

  test('keeps a plausible reading over a later warning', () => {
    expect(preferredOdometer(plausible, warning)).toBe(plausible);
  });

  test('upgrades from a warning to a plausible reading', () => {
    expect(preferredOdometer(warning, plausible)).toBe(plausible);
  });

  test('refreshes on equal confidence and tolerates null', () => {
    // Equal confidence takes the newer frame, so the display tracks the live
    // image rather than freezing on whatever was seen first.
    const second: OdometerCandidate = {
      value: 42_461,
      validation: { kind: 'plausible', milesSinceLast: 311 },
    };
    expect(preferredOdometer(plausible, second)).toBe(second);
    expect(preferredOdometer(plausible, null)).toBe(plausible);
    expect(preferredOdometer(null, plausible)).toBe(plausible);
    expect(preferredOdometer(null, null)).toBeNull();
  });

  test('ranks every verdict in a strict order', () => {
    const noHistory: OdometerCandidate = { value: 1, validation: { kind: 'noHistory' } };
    const far: OdometerCandidate = {
      value: 2,
      validation: { kind: 'implausiblyFar', last: 1, miles: 1 },
    };
    expect(preferredOdometer(noHistory, far)).toBe(noHistory);
    expect(preferredOdometer(far, warning)).toBe(far);
    expect(preferredOdometer(noHistory, plausible)).toBe(plausible);
  });
});
