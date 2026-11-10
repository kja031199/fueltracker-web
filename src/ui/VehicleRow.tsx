import type { ReactElement } from 'react';
import { useState } from 'react';
import type { VehicleRecord } from '../data/records';
import { vehicleSubtitle } from './wording';
import { useFuelLog } from './fuelLog';
import { SharePanel } from './SharePanel';
import { ConfirmButton } from './ConfirmButton';
import { RequestLinkPanel } from './RequestLinkPanel';

/**
 * What a car's row is doing: nothing, showing its sharing panel or its
 * fill-up request link, or asking before it leaves or deletes.
 *
 * One state, not four (#93). The screen used to keep a separate id for each,
 * so a row could be sharing and requesting at once, and the rules for which
 * buttons show were spread across four comparisons.
 */
export type VehicleRowMode = 'idle' | 'sharing' | 'requesting' | 'leaving' | 'confirming';

export function VehicleRow({
  vehicle,
  selected,
  onSelect,
  ownerName,
}: {
  readonly vehicle: VehicleRecord;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
  /** The signed-in account's name, for the request link (#3). */
  readonly ownerName: string;
}): ReactElement {
  const { removeVehicle, sharing } = useFuelLog();
  const [mode, setMode] = useState<VehicleRowMode>('idle');
  const toggle = (next: VehicleRowMode): void => setMode((current) => (current === next ? 'idle' : next));
  const subtitle = vehicleSubtitle(vehicle);
  // A car shared *with* you is its owner's: you can leave it, not delete or
  // share it (#66).
  const membership = sharing.membershipFor(vehicle.id);

  async function remove(): Promise<void> {
    await removeVehicle(vehicle.id);
    setMode('idle');
  }

  // Deleting a vehicle takes its whole history with it, so it asks first
  // rather than offering an undo that does not exist yet.
  const deleting = (
    <ConfirmButton
      asking={mode === 'confirming'}
      onAsk={() => setMode('confirming')}
      onCancel={() => setMode('idle')}
      onConfirm={() => void remove()}
      label="Delete"
      confirmLabel={`Delete ${vehicle.name} and its fill-ups${
        sharing.enabled ? ', for everyone it is shared with' : ''
      }`}
      cancelLabel="Keep"
      labelSuffix={vehicle.name}
    />
  );

  return (
    <li className="card">
      <div className="row-between">
        <div>
          <strong>{vehicle.name}</strong>
          {subtitle !== '' && <div className="note">{subtitle}</div>}
          {membership !== undefined && (
            <div className="note">Shared with you by {membership.ownerName || 'its owner'}</div>
          )}
        </div>
        {selected && <span className="accent-blue bold">Selected</span>}
      </div>
      <div className="row-actions space-above-sm">
        {!selected && (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => onSelect(vehicle.id)}
            aria-label={`Select ${vehicle.name}`}
          >
            Select
          </button>
        )}
        {membership !== undefined ? (
          <ConfirmButton
            asking={mode === 'leaving'}
            onAsk={() => setMode('leaving')}
            onCancel={() => setMode('idle')}
            onConfirm={() => {
              setMode('idle');
              void sharing.leave(membership);
            }}
            label="Leave"
            confirmLabel={`Leave ${vehicle.name}`}
            cancelLabel="Stay"
            tone="secondary"
            labelSuffix={vehicle.name}
          />
        ) : mode === 'confirming' ? (
          deleting
        ) : (
          <>
            <button
              className="button button--secondary"
              type="button"
              aria-expanded={mode === 'requesting'}
              onClick={() => toggle('requesting')}
              aria-label={
                mode === 'requesting'
                  ? `Done with the request link for ${vehicle.name}`
                  : `Request a fill-up for ${vehicle.name}`
              }
            >
              {mode === 'requesting' ? 'Done' : 'Request a fill-up'}
            </button>
            {sharing.enabled && (
              <button
                className="button button--secondary"
                type="button"
                aria-expanded={mode === 'sharing'}
                onClick={() => toggle('sharing')}
                aria-label={`${mode === 'sharing' ? 'Done sharing' : 'Share'} ${vehicle.name}`}
              >
                {mode === 'sharing' ? 'Done sharing' : 'Share'}
              </button>
            )}
            {deleting}
          </>
        )}
      </div>
      {membership !== undefined && mode === 'leaving' && (
        <p className="after-sm">
          Leaving removes {vehicle.name} from this device and your others. Fill-ups you logged stay with{' '}
          {membership.ownerName || 'its owner'}.
        </p>
      )}
      {membership === undefined && mode === 'sharing' && <SharePanel vehicle={vehicle} />}
      {membership === undefined && mode === 'requesting' && (
        <RequestLinkPanel vehicle={vehicle} ownerName={ownerName} />
      )}
    </li>
  );
}
