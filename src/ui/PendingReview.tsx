import type { ReactElement } from 'react';
import { useState } from 'react';
import { currency, distance as formatDistance, volume as formatVolume } from '../domain/format';
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
    <section className="card" aria-labelledby="pending-heading" style={{ marginBottom: 'var(--gap)' }}>
      <h2 className="card__title" id="pending-heading">
        Waiting for review ({pending.length})
      </h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: 0 }}>
        Sent to you by link. Nothing here is in your log until you approve it.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {pending.map((row) => {
          const car = vehicles.find((vehicle) => vehicle.id === row.vehicleId);
          return (
            <li key={row.id} style={{ borderTop: '1px solid var(--separator)', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <strong>{car?.name ?? 'A deleted car'}</strong>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {' '}
                    · from {row.submitterName || 'someone'} · {new Date(row.date).toLocaleDateString()}
                  </span>
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    {formatVolume(row.gallons, units.volume, true)} ·{' '}
                    {formatDistance(row.odometer, units.distance, true)} · {row.fuelGrade}
                    {!row.isFullTank && ' · partial fill'}
                    {row.station !== '' && ` · ${row.station}`}
                  </div>
                  {row.notes !== '' && <div style={{ fontSize: '0.9rem' }}>{row.notes}</div>}
                </div>
                <strong>{currency(totalCost(row))}</strong>
              </div>
              {refused === row.id && (
                <p className="warning" role="alert" style={{ margin: '8px 0 0' }}>
                  This could not be added — its car is gone, or its numbers no longer check out. Reject it to
                  clear it.
                </p>
              )}
              <div className="row-actions" style={{ marginTop: 8 }}>
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
