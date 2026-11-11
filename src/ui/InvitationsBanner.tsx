import type { ReactElement } from 'react';
import { useState } from 'react';
import type { Invite } from '../data/sharing';
import { ShareClash } from '../data/sharing';
import { useFuelLog } from './fuelLog';

/**
 * "Kyle wants to share Civic with you" (#66), at the top of every screen
 * until it is answered — joining is always the invitee's own decision, so
 * the app asks rather than acting on an invitation by itself.
 *
 * Says what accepting means before it happens: the car and its whole history
 * arrive, including receipt photos and notes, and the other person sees the
 * fill-ups logged here.
 */
export function InvitationsBanner(): ReactElement | null {
  const { sharing } = useFuelLog();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (!sharing.enabled || sharing.invitesForMe.length === 0) return null;

  async function answer(invite: Invite, accept: boolean): Promise<void> {
    const key = `${invite.ownerUid}/${invite.vehicleId}`;
    setBusy(key);
    setProblem(null);
    try {
      if (accept) await sharing.accept(invite);
      else await sharing.decline(invite);
    } catch (cause) {
      setProblem(
        cause instanceof ShareClash
          ? // #78: not a network blip, and retrying will not help.
            `Not accepted: ${invite.vehicleName || 'that car'} has the identity of a car that is already one of your cars, ` +
              'and accepting would hand yours over. Decline it.'
          : 'That could not be answered just now. Check your connection and try again.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" aria-label="Invitations">
      {sharing.invitesForMe.map((invite) => {
        const key = `${invite.ownerUid}/${invite.vehicleId}`;
        const who = invite.ownerName || 'Someone';
        const car = invite.vehicleName || 'a car';
        return (
          <div className="space-below-sm" key={key}>
            <p className="stack-sm">
              <strong>{who}</strong> wants to share <strong>{car}</strong> with you. You would both see and log its
              fill-ups — including receipt photos, notes and stations.
            </p>
            <div className="row-actions">
              <button
                className="button"
                type="button"
                disabled={busy !== null}
                onClick={() => void answer(invite, true)}
              >
                Accept {car}
              </button>
              <button
                className="button button--secondary"
                type="button"
                disabled={busy !== null}
                onClick={() => void answer(invite, false)}
              >
                Decline
              </button>
            </div>
          </div>
        );
      })}
      {problem !== null && (
        <p className="warning flush" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
