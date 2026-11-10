import type { ReactElement } from 'react';
import { useId } from 'react';
import type { UnitPreferences } from '../../domain/units';
import { DISTANCE_UNITS, ECONOMY_UNITS, VOLUME_UNITS, distance, economy, volume } from '../../domain/units';
import { CURRENCIES } from '../../domain/format';
import { useDisplay, useUnits } from '../session';

/**
 * Settings → Units and currency. Changing a unit changes only what is shown and
 * what typed numbers are read as; every stored value stays canonical, so
 * nothing is rewritten and nothing can be lost in a conversion. The currency is
 * the same (#94): it changes the symbol and format of amounts, and converts
 * nothing — a price is whatever was typed at the pump.
 */
export function UnitsSection(): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  const { units, setUnits: onChange } = useUnits();
  const { style, setCurrency } = useDisplay();
  const currencies = CURRENCIES.includes(style.currency) ? CURRENCIES : [...CURRENCIES, style.currency].sort();
  return (
    <section className="card" aria-labelledby={`${idBase}-units-heading`}>
      <h2 className="card__title" id={`${idBase}-units-heading`}>
        Units and currency
      </h2>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-unit-volume`}>
          Volume
        </label>
        <select
          id={`${idBase}-unit-volume`}
          value={units.volume}
          onChange={(e) =>
            onChange({ ...units, volume: e.target.value as UnitPreferences['volume'] })
          }
        >
          {VOLUME_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {volume[unit].name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-unit-distance`}>
          Distance
        </label>
        <select
          id={`${idBase}-unit-distance`}
          value={units.distance}
          onChange={(e) =>
            onChange({ ...units, distance: e.target.value as UnitPreferences['distance'] })
          }
        >
          {DISTANCE_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {distance[unit].name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-unit-economy`}>
          Fuel economy
        </label>
        <select
          id={`${idBase}-unit-economy`}
          value={units.economy}
          onChange={(e) =>
            onChange({ ...units, economy: e.target.value as UnitPreferences['economy'] })
          }
        >
          {ECONOMY_UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {economy[unit].name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idBase}-currency`}>
          Currency
        </label>
        <select
          id={`${idBase}-currency`}
          aria-describedby={`${idBase}-currency-note`}
          value={style.currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {currencies.map((code) => (
            <option key={code} value={code}>
              {currencyLabel(code, style.locale)}
            </option>
          ))}
        </select>
        <p className="fine" id={`${idBase}-currency-note`}>
          Only changes how amounts are shown. Prices you have entered are not converted.
        </p>
      </div>

      <p className="note flush">
        Readings are stored in miles, US gallons and MPG whatever you pick here — changing a unit
        changes what you see and type, never what is saved.
      </p>
    </section>
  );
}

/** `EUR — €`: the code, and the symbol the reader's locale writes for it. */
function currencyLabel(code: string, locale: string): string {
  try {
    const symbol = new Intl.NumberFormat(locale, { style: 'currency', currency: code })
      .formatToParts(0)
      .find((part) => part.type === 'currency')?.value;
    return symbol === undefined || symbol === code ? code : `${code} — ${symbol}`;
  } catch {
    return code;
  }
}
