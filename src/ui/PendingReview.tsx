import type { ReactElement } from 'react';
import { useState } from 'react';
import { fillUpFacts } from '../domain/format';
import { FillUpSummary } from './FillUpSummary';
import type { UnitPreferences } from '../domain/units';
import { totalCost } from '../domain/models';
import { useFuelLog } from './fuelLog';

/**
 * Fill-ups sent by link, waiting for the owner (#3): **Approve** adds one to
 * the log — validated again, and refused if its car has since been deleted —
 * and **Reject** drops it. Every car's are listed, whichever is selected, so
 * nothing sent waits unseen behind a car that is not.
 *
 * Nothing is shown when nothing is waiting.
 */
export function PendingReview({ units }: { readonly units: UnitPreferences }): ReactElement | null {
  const { pending, vehicles, approveSubmission, rejectSubmission } = useFuelLog();
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (pending.length === 0) return null;

  async function approve(id: string): Promise<void> {
    setBusy(id);
    try {
      const made = await approveSubmission(id);
      setRefused(made === null ? id : null);
    } finally {
      setBusy(null);
    }
  }

  async function reject(id: string): Promise<void> {
    setBusy(id);
    try {
      await rejectSubmission(id);
      if (refused === id) setRefused(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card space-below" aria-labelledby="pending-heading">
      <h2 className="card__title" id="pending-heading">
        Waiting for review ({pending.length})
      </h2>
      <p className="note flush-top">
        Sent to you by link. Nothing here is in your log until you approve it.
      </p>
      <ul className="list-plain">
        {pending.map((row) => {
          const car = vehicles.find((vehicle) => vehicle.id === row.vehicleId);
          return (
            <li className="list-row" key={row.id}>
              <FillUpSummary
                title={car?.name ?? 'A deleted car'}
                subtitle={`from ${row.submitterName || 'someone'} · ${new Date(row.date).toLocaleDateString()}`}
                facts={[...fillUpFacts(row, units), ...(row.station === '' ? [] : [row.station])]}
                notes={row.notes}
                cost={totalCost(row)}
              />
              {refused === row.id && (
                <p className="warning after-sm" role="alert">
                  This could not be added — its car is gone, or its numbers no longer check out. Reject it to
                  clear it.
                </p>
              )}
              <div className="row-actions space-above-sm">
                {car !== undefined && (
                  <button
                    className="button"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void approve(row.id)}
                    aria-label={`Approve the fill-up from ${row.submitterName || 'someone'} for ${car.name}`}
                  >
                    Approve
                  </button>
                )}
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void reject(row.id)}
                  aria-label={`Reject the fill-up from ${row.submitterName || 'someone'}${car === undefined ? '' : ` for ${car.name}`}`}
                >
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
