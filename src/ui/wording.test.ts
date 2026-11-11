import { describe, expect, test } from 'vitest';
import { METRIC, US } from '../domain/units';
import { describeSince, displayName, fillUpFacts, fillUpName, vehicleSubtitle, verifiedName } from './wording';

/**
 * The words the screens put around values (#94: moved here from
 * `domain/format.test.ts` with the functions they test).
 */

describe('describeSince, how long ago something last happened (#93: moved from Settings)', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime();

  test('says so plainly when nothing has synced yet', () => {
    expect(describeSince(null, now)).toBe('not yet');
  });

  test('reads as just now inside a minute', () => {
    expect(describeSince(now - 5_000, now)).toBe('just now');
  });

  test('counts minutes, then hours', () => {
    expect(describeSince(now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(describeSince(now - 60_000, now)).toBe('1 minute ago');
    expect(describeSince(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(describeSince(now - 3_600_000, now)).toBe('1 hour ago');
  });

  test('falls back to a date once it stops being recent', () => {
    expect(describeSince(now - 3 * 24 * 3_600_000, now)).toBe(new Date(now - 3 * 24 * 3_600_000).toLocaleDateString());
  });

  test('does not read a clock-skewed future timestamp as a negative age', () => {
    // A device whose clock is ahead would otherwise produce "-4 minutes ago".
    expect(describeSince(now + 240_000, now)).toBe('just now');
  });

  test('the edges between seconds, minutes, hours and a date', () => {
    expect(describeSince(now - 59_000, now)).toBe('just now');
    expect(describeSince(now - 60_000, now)).toBe('1 minute ago');
    expect(describeSince(now - 59 * 60_000, now)).toBe('59 minutes ago');
    expect(describeSince(now - 23 * 3_600_000, now)).toBe('23 hours ago');
    expect(describeSince(now - 24 * 3_600_000, now)).toBe(new Date(now - 24 * 3_600_000).toLocaleDateString());
  });

  test('a time that is not a number reads as never, not as "Invalid Date"', () => {
    expect(describeSince(Number.NaN, now)).toBe('not yet');
    expect(describeSince(Number.POSITIVE_INFINITY, now)).toBe('not yet');
    expect(describeSince(Number.NEGATIVE_INFINITY, now)).toBe('not yet');
  });
});

describe('vehicleSubtitle (#93: moved from Vehicles)', () => {
  const car = { year: 2021, make: 'Honda', model: 'Civic' };

  test('year, make and model, as one line', () => {
    expect(vehicleSubtitle(car)).toBe('2021 Honda Civic');
  });

  test('a part left empty is left out, not shown as a gap', () => {
    expect(vehicleSubtitle({ ...car, make: '' })).toBe('2021 Civic');
    expect(vehicleSubtitle({ ...car, model: '' })).toBe('2021 Honda');
  });

  test('a year alone says nothing worth a line', () => {
    expect(vehicleSubtitle({ ...car, make: '', model: '' })).toBe('');
    expect(vehicleSubtitle({ year: 0, make: '', model: '' })).toBe('');
  });
});

describe('displayName, who a person is shown as (#93: four copies before)', () => {
  test('their name, when they gave one', () => {
    expect(displayName({ name: 'Sam', email: 'sam@example.com' })).toBe('Sam');
  });

  test('their email when the name is empty — or only spaces, which used to show as a blank', () => {
    expect(displayName({ name: '', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(displayName({ name: '   ', email: 'sam@example.com' })).toBe('sam@example.com');
  });

  test('the fallback when there is neither', () => {
    expect(displayName({ name: '', email: '' })).toBe('someone');
    expect(displayName({ name: ' ', email: ' ' }, 'its owner')).toBe('its owner');
  });

  test('trimmed, so stray spaces never reach a sentence', () => {
    expect(displayName({ name: '  Sam ', email: '' })).toBe('Sam');
    expect(displayName({ name: '', email: ' sam@example.com ' })).toBe('sam@example.com');
  });
});

describe('verifiedName, a sharer as only they can be (#81)', () => {
  // The name is whatever a person typed; the email is the one Google verified,
  // which the rules force a member's to be. So the email is always shown, and
  // a name never stands in for it.
  test('the name they chose, with the email that says who they are', () => {
    expect(verifiedName({ name: 'Sam', email: 'sam@example.com' })).toBe('Sam (sam@example.com)');
  });

  test('a member calling themselves the owner still shows their own email', () => {
    expect(verifiedName({ name: 'Kyle', email: 'not.kyle@example.com' })).toBe('Kyle (not.kyle@example.com)');
  });

  test('just the email when the name is blank, only spaces, or the email again', () => {
    expect(verifiedName({ name: '', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(verifiedName({ name: '   ', email: 'sam@example.com' })).toBe('sam@example.com');
    expect(verifiedName({ name: 'Sam@Example.com', email: 'sam@example.com' })).toBe('sam@example.com');
  });

  test('a name that looks like someone else’s email does not hide the real one', () => {
    expect(verifiedName({ name: 'kyle@example.com', email: 'sam@example.com' })).toBe(
      'kyle@example.com (sam@example.com)',
    );
  });

  test('trimmed, and the fallback when there is neither', () => {
    expect(verifiedName({ name: '  Sam ', email: ' sam@example.com ' })).toBe('Sam (sam@example.com)');
    expect(verifiedName({ name: 'Sam', email: '' })).toBe('Sam');
    expect(verifiedName({ name: ' ', email: ' ' })).toBe('someone');
    expect(verifiedName({ name: '', email: '' }, 'a member')).toBe('a member');
  });
});

describe('fillUpFacts, the grey line under a fill-up (#93: two copies before)', () => {
  const entry = { gallons: 10, odometer: 12_345, fuelGrade: 'Regular', isFullTank: true, missedPreviousFillUp: false };

  test('volume, distance and grade, in the reader’s units', () => {
    expect(fillUpFacts(entry, US)).toEqual(['10 gal', '12,345 mi', 'Regular']);
    const metric = fillUpFacts(entry, METRIC);
    expect(metric[0]).toMatch(/^37\.854 L$/);
    expect(metric[1]).toBe('19,867.4 km');
  });

  test('a partial fill says so', () => {
    expect(fillUpFacts({ ...entry, isFullTank: false }, US)).toContain('partial fill');
  });

  test('a missed fill-up is said only where the line is about the reader’s own log', () => {
    const missed = { ...entry, missedPreviousFillUp: true };
    expect(fillUpFacts(missed, US, { missed: true })).toContain('missed previous');
    expect(fillUpFacts(missed, US)).not.toContain('missed previous');
    expect(fillUpFacts(entry, US, { missed: true })).not.toContain('missed previous');
  });

  test('zero and huge numbers are written out, never as NaN', () => {
    const facts = fillUpFacts({ ...entry, gallons: 0, odometer: 9_999_999 }, US).join(' · ');
    expect(facts).not.toMatch(/NaN|Infinity|undefined/);
  });
});

describe('fillUpName, which fill-up a row’s buttons are for (#95)', () => {
  const entry = { date: new Date(2026, 0, 5, 9, 0).getTime(), odometer: 10_000 };

  test('its date and its odometer reading, in the reader’s units', () => {
    expect(fillUpName(entry, US)).toBe(`the fill-up of ${new Date(entry.date).toLocaleDateString()} at 10,000 mi`);
    expect(fillUpName(entry, METRIC)).toMatch(/at 16,093\.4 km$/);
  });

  test('two on the same day are still told apart', () => {
    expect(fillUpName({ ...entry, odometer: 10_250 }, US)).not.toBe(fillUpName(entry, US));
  });
});

describe('phrased in the reader\u2019s locale (#94)', () => {
  test('the fill-up\u2019s name, its facts and an old date follow the locale', () => {
    const may1 = new Date(2026, 4, 1).getTime();
    expect(fillUpName({ date: may1, odometer: 10_000 }, METRIC, 'de-DE')).toBe(
      'the fill-up of 1.5.2026 at 16.093,4 km',
    );
    expect(
      fillUpFacts({ gallons: 10, odometer: 10_000, fuelGrade: 'Regular', isFullTank: true }, METRIC, {
        locale: 'de-DE',
      }),
    ).toEqual(['37,854 L', '16.093,4 km', 'Regular']);
    expect(describeSince(may1, may1 + 3 * 86_400_000, 'de-DE')).toBe('1.5.2026');
  });
});
