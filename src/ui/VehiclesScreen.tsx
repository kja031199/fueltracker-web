import type { ReactElement } from 'react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { VehicleRecord } from '../data/records';
import type { FuelTrackerStore } from '../data/store';

interface Props {
  readonly store: FuelTrackerStore;
  readonly vehicles: readonly VehicleRecord[];
  readonly selectedVehicleId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onChanged: () => Promise<void>;
}

/** "2021 Honda Civic", or nothing when only the year is known. */
export function vehicleSubtitle(vehicle: VehicleRecord): string {
  const parts = [String(vehicle.year), vehicle.make, vehicle.model].filter((p) => p !== '');
  const joined = parts.join(' ');
  return joined === String(vehicle.year) ? '' : joined;
}

export function VehiclesScreen({
  store,
  vehicles,
  selectedVehicleId,
  onSelect,
  onChanged,
}: Props): ReactElement {
  const [name, setName] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const canAdd = name.trim() !== '';

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canAdd) return;
    const parsedYear = Number.parseInt(year, 10);
    await store.addVehicle({
      name: name.trim(),
      make: make.trim(),
      model: model.trim(),
      // A blank or nonsense year falls back to this one rather than storing NaN.
      year: Number.isFinite(parsedYear) ? parsedYear : new Date().getFullYear(),
    });
    setName('');
    setMake('');
    setModel('');
    await onChanged();
  }

  async function remove(id: string): Promise<void> {
    await store.removeVehicle(id);
    setConfirmingId(null);
    await onChanged();
  }

  return (
    <div>
      <section className="card" aria-labelledby="add-vehicle-heading">
        <h2 className="card__title" id="add-vehicle-heading">
          Add a vehicle
        </h2>
        <form onSubmit={(event) => void add(event)}>
          <div className="field">
            <label className="field__label" htmlFor="vehicle-name">
              Name
            </label>
            <input
              id="vehicle-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Daily Driver"
              required
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="vehicle-make">
              Make
            </label>
            <input id="vehicle-make" value={make} onChange={(e) => setMake(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="vehicle-model">
              Model
            </label>
            <input id="vehicle-model" value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="vehicle-year">
              Year
            </label>
            <input
              id="vehicle-year"
              type="number"
              inputMode="numeric"
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </div>
          <button className="button" type="submit" disabled={!canAdd}>
            Add vehicle
          </button>
        </form>
      </section>

      <section aria-labelledby="vehicles-heading">
        <h2 className="card__title" id="vehicles-heading">
          Your vehicles
        </h2>
        {vehicles.length === 0 ? (
          <p className="empty">No vehicles yet. Add one above to start logging fill-ups.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {vehicles.map((vehicle) => {
              const subtitle = vehicleSubtitle(vehicle);
              const selected = vehicle.id === selectedVehicleId;
              return (
                <li className="card" key={vehicle.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <strong>{vehicle.name}</strong>
                      {subtitle !== '' && (
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                          {subtitle}
                        </div>
                      )}
                    </div>
                    {selected && (
                      <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>Selected</span>
                    )}
                  </div>
                  <div className="row-actions" style={{ marginTop: 10 }}>
                    {!selected && (
                      <button
                        className="button button--secondary"
                        type="button"
                        onClick={() => onSelect(vehicle.id)}
                      >
                        Select
                      </button>
                    )}
                    {confirmingId === vehicle.id ? (
                      <>
                        {/* Deleting a vehicle takes its whole history with it,
                            so it asks first rather than offering an undo that
                            does not exist yet. */}
                        <button
                          className="button button--danger"
                          type="button"
                          onClick={() => void remove(vehicle.id)}
                        >
                          Delete {vehicle.name} and its fill-ups
                        </button>
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => setConfirmingId(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => setConfirmingId(vehicle.id)}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
