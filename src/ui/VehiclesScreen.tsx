import type { ReactElement } from 'react';
import { useId } from 'react';
import { useFuelLog } from './fuelLog';
import { AddVehicleForm } from './AddVehicleForm';
import { VehicleRow } from './VehicleRow';
import { useSession } from './session';

/**
 * Vehicles, read from and written through the fuel log (#56): the add form,
 * and a row per car that keeps its own one mode (#93).
 */
export function VehiclesScreen(): ReactElement {
  // One base per rendering, so a component shown twice never repeats an id (#95).
  const idBase = useId();
  // The owner's name, for the fill-up request link (#3).
  const ownerName = useSession().account?.displayName ?? '';
  const { vehicles, selectedVehicleId, selectVehicle } = useFuelLog();

  return (
    <div>
      <AddVehicleForm />

      <section aria-labelledby={`${idBase}-vehicles-heading`}>
        <h2 className="card__title" id={`${idBase}-vehicles-heading`}>
          Your vehicles
        </h2>
        {vehicles.length === 0 ? (
          <p className="empty">No vehicles yet. Add one above to start logging fill-ups.</p>
        ) : (
          <ul className="list-plain">
            {vehicles.map((vehicle) => (
              <VehicleRow
                key={vehicle.id}
                vehicle={vehicle}
                selected={vehicle.id === selectedVehicleId}
                onSelect={selectVehicle}
                ownerName={ownerName}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
