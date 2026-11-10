import { describe, expect, test } from 'vitest';
import { METRIC, US } from '../domain/units';
import { insightText } from './insightText';

/**
 * The weekday insight as a sentence (#94: these assertions moved here from
 * `domain/weekdayPricePattern.test.ts` when the sentence did). Tuesday is
 * weekday 3 and Friday 6, with an 11¢-per-gallon spread.
 */
const TUESDAY_CHEAPER = { cheapestWeekday: 3, priciestWeekday: 6, spreadPerGallon: 0.11 };

describe('the insight headline', () => {
  test('names the cheapest and priciest days with the spread, cheaper first', () => {
    expect(insightText(TUESDAY_CHEAPER)).toBe('You pay about $0.11/gal less on Tuesdays than Fridays.');
  });

  test('converts the spread into the reader volume unit', () => {
    // The same 11¢/gallon gap is about 2.9¢/litre. Relabelling the unit without
    // converting the number would overstate the saving by 3.8x.
    expect(insightText(TUESDAY_CHEAPER, US)).toContain('$0.11/gal');
    expect(insightText(TUESDAY_CHEAPER, METRIC)).toContain('$0.03/L');
  });

  test('the amount follows the reader’s currency; the day names stay with the English sentence', () => {
    const german = insightText(TUESDAY_CHEAPER, METRIC, { locale: 'de-DE', currency: 'EUR' });
    expect(german).toBe('You pay about 0,03 €/L less on Tuesdays than Fridays.');
  });

  test('every weekday has a name, Sunday to Saturday', () => {
    expect(insightText({ cheapestWeekday: 1, priciestWeekday: 7, spreadPerGallon: 0.5 })).toBe(
      'You pay about $0.50/gal less on Sundays than Saturdays.',
    );
  });
});
