/**
 * The weekday price pattern as a sentence (#94): "You pay about $0.11/gal less
 * on Tuesdays than Fridays." `domain/weekdayPricePattern.ts` finds the pattern
 * and hands over its two weekdays and the spread per US gallon; the words,
 * the reader's volume unit and their currency are applied here.
 *
 * The day names are English whatever the reader's locale, because the
 * sentence around them is English: "less on Dienstags than Freitags" helps
 * nobody. The amount is in the reader's locale and currency.
 */

import type { WeekdayInsight } from '../domain/weekdayPricePattern';
import { weekdayNames } from './words';
import type { UnitPreferences } from '../domain/units';
import { US, pricePerUnit, volume } from '../domain/units';
import type { DisplayStyle } from '../domain/format';
import { US_STYLE, plainCurrency } from '../domain/format';

export function insightText(
  insight: WeekdayInsight,
  units: UnitPreferences = US,
  style: DisplayStyle = US_STYLE,
): string {
  const names = weekdayNames(US_STYLE.locale, 'long');
  const cheapName = names[insight.cheapestWeekday - 1] ?? '';
  const priceyName = names[insight.priciestWeekday - 1] ?? '';
  const perUnitDelta = plainCurrency(pricePerUnit(insight.spreadPerGallon, units.volume), style);
  return `You pay about ${perUnitDelta}/${volume[units.volume].abbreviation} less on ${cheapName}s than ${priceyName}s.`;
}
