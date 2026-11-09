import type { ReactElement } from 'react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { vehicleSubtitle } from '../domain/format';
import { useFuelLog } from './fuelLog';
import { SharePanel } from './SharePanel';
import { RequestLinkPanel } from './RequestLinkPanel';
import { TEXT_LIMITS } from '../domain/textLimits';

/** Vehicles, read from and written through the fuel log (#56). */
export function VehiclesScreen({ ownerName = '' }: { readonly ownerName?: string } = {}): ReactElement {
  const { vehicles, selectedVehicleId, selectVehicle: onSelect, addVehicle, removeVehicle, sharing } =
    useFuelLog();
  // Which car's sharing panel is open, and which shared car is being left.
  const [sharingId, setSharingId] = useState<string | null>(null);
  // Which car's fill-up request link is showing (#3).
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
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
    await addVehicle({
      name: name.trim(),
      make: make.trim(),
      model: model.trim(),
      // A blank or nonsense year falls back to this one rather than storing NaN.
      year: Number.isFinite(parsedYear) ? parsedYear : new Date().getFullYear(),
    });
    setName('');
    setMake('');
    setModel('');
  }

  async function remove(id: string): Promise<void> {
    await removeVehicle(id);
    setConfirmingId(null);
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
              maxLength={TEXT_LIMITS.name}
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
            <input id="vehicle-make" maxLength={TEXT_LIMITS.make} value={make} onChange={(e) => setMake(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="vehicle-model">
              Model
            </label>
            <input id="vehicle-model" maxLength={TEXT_LIMITS.model} value={model} onChange={(e) => setModel(e.target.value)} />
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
              // A car shared *with* you is its owner's: you can leave it, not
              // delete or share it (#66).
              const membership = sharing.membershipFor(vehicle.id);
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
                      {membership !== undefined && (
                        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                          Shared with you by {membership.ownerName || 'its owner'}
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
                    {membership !== undefined ? (
                      leavingId === vehicle.id ? (
                        <>
                          <button
                            className="button button--danger"
                            type="button"
                            onClick={() => {
                              setLeavingId(null);
                              void sharing.leave(membership);
                            }}
                          >
                            Leave {vehicle.name}
                          </button>
                          <button
                            className="button button--secondary"
                            type="button"
                            onClick={() => setLeavingId(null)}
                          >
                            Stay
                          </button>
                        </>
                      ) : (
                        <button
                          className="button button--secondary"
                          type="button"
                          onClick={() => setLeavingId(vehicle.id)}
                        >
                          Leave
                        </button>
                      )
                    ) : confirmingId === vehicle.id ? (
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
                          {sharing.enabled ? ', for everyone it is shared with' : ''}
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
                      <>
                        <button
                          className="button button--secondary"
                          type="button"
                          aria-expanded={requestingId === vehicle.id}
                          onClick={() => setRequestingId(requestingId === vehicle.id ? null : vehicle.id)}
                        >
                          {requestingId === vehicle.id ? 'Done' : 'Request a fill-up'}
                        </button>
                        {sharing.enabled && (
                          <button
                            className="button button--secondary"
                            type="button"
                            aria-expanded={sharingId === vehicle.id}
                            onClick={() => setSharingId(sharingId === vehicle.id ? null : vehicle.id)}
                          >
                            {sharingId === vehicle.id ? 'Done sharing' : 'Share'}
                          </button>
                        )}
                        <button
                          className="button button--danger"
                          type="button"
                          onClick={() => setConfirmingId(vehicle.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                  {membership !== undefined && leavingId === vehicle.id && (
                    <p style={{ margin: '8px 0 0' }}>
                      Leaving removes {vehicle.name} from this device and your others. Fill-ups you logged
                      stay with {membership.ownerName || 'its owner'}.
                    </p>
                  )}
                  {membership === undefined && sharingId === vehicle.id && <SharePanel vehicle={vehicle} />}
                  {membership === undefined && requestingId === vehicle.id && (
                    <RequestLinkPanel vehicle={vehicle} ownerName={ownerName} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
