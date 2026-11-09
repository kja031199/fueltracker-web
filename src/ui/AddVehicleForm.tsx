import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { vehicleYear } from '../domain/format';
import { TEXT_LIMITS } from '../domain/textLimits';
import { useFuelLog } from './fuelLog';

/** Adding a car (#93: moved out of the Vehicles screen with its four fields). */
export function AddVehicleForm(): ReactElement {
  const { addVehicle } = useFuelLog();
  const [name, setName] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState(String(new Date().getFullYear()));

  const canAdd = name.trim() !== '';

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canAdd) return;
    await addVehicle({
      name: name.trim(),
      make: make.trim(),
      model: model.trim(),
      // A blank or nonsense year falls back to this one rather than storing NaN.
      year: vehicleYear(year),
    });
    setName('');
    setMake('');
    setModel('');
  }

  return (
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
  );
}
