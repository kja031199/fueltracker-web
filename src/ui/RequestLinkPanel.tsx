import type { ReactElement } from 'react';
import { useMemo } from 'react';
import type { VehicleRecord } from '../data/records';
import { requestUrl } from '../data/fillUpLink';
import { LinkOut, appBase } from './LinkOut';

/**
 * Asking someone to log a fill-up for one of your cars (#3).
 *
 * The link names the car and you, and nothing else of your log. Whoever opens
 * it — signed in to FuelTracker — fills the fill-up in and gets a link to send
 * back; opening that one puts it in front of you to approve. Offered only on
 * your own cars: a car shared with you is its owner's to ask about.
 */
export function RequestLinkPanel({
  vehicle,
  ownerName,
}: {
  readonly vehicle: Pick<VehicleRecord, 'id' | 'name'>;
  readonly ownerName: string;
}): ReactElement {
  const url = useMemo(
    () => requestUrl(appBase(), { vehicleId: vehicle.id, vehicleName: vehicle.name, ownerName }),
    [vehicle.id, vehicle.name, ownerName],
  );
  return (
    <div className="space-above-sm">
      <p className="stack-sm">
        Send this to whoever is filling up {vehicle.name}. They fill in the fill-up and send you a link back; nothing
        reaches your log until you approve it under Fill-ups.
      </p>
      <LinkOut url={url} label={`Fill-up request for ${vehicle.name}`} />
    </div>
  );
}
