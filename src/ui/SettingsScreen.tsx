import type { ReactElement } from 'react';
import type { UnitPreferences } from '../domain/units';
import {
  DISTANCE_UNITS,
  ECONOMY_UNITS,
  VOLUME_UNITS,
  distance,
  economy,
  volume,
} from '../domain/units';

interface Props {
  readonly units: UnitPreferences;
  readonly onChange: (units: UnitPreferences) => void;
}

/**
 * Units, and the honest note about where the data lives.
 *
 * Changing a unit changes only what is shown and what typed numbers are read
 * as; every stored value stays canonical, so nothing is rewritten and nothing
 * can be lost in a conversion.
 */
export function SettingsScreen({ units, onChange }: Props): ReactElement {
  return (
    <div>
      <section className="card" aria-labelledby="units-heading">
        <h2 className="card__title" id="units-heading">
          Units
        </h2>

        <div className="field">
          <label className="field__label" htmlFor="unit-volume">
            Volume
          </label>
          <select
            id="unit-volume"
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
          <label className="field__label" htmlFor="unit-distance">
            Distance
          </label>
          <select
            id="unit-distance"
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
          <label className="field__label" htmlFor="unit-economy">
            Fuel economy
          </label>
          <select
            id="unit-economy"
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

        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: 0 }}>
          Readings are stored in miles, US gallons and MPG whatever you pick here — changing a unit
          changes what you see and type, never what is saved.
        </p>
      </section>

      <section className="card" aria-labelledby="storage-heading">
        <h2 className="card__title" id="storage-heading">
          Where your data lives
        </h2>
        <p style={{ margin: '0 0 8px' }}>
          Everything is stored in this browser, on this device. There is no account and no server,
          so nothing is uploaded anywhere.
        </p>
        <p className="warning" style={{ margin: 0 }}>
          That also means clearing your browser data will delete your fuel log. Export is not built
          yet — until it is, treat this as something to try rather than your only record.
        </p>
      </section>
    </div>
  );
}
