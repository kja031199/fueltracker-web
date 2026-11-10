import type { FormEvent, ReactElement } from 'react';
import { verifiedName } from '../domain/format';
import { useCallback, useEffect, useState } from 'react';
import type { VehicleRecord } from '../data/records';
import type { Invite, Member } from '../data/sharing';
import { MAX_EMAIL_LENGTH, normalizeEmail } from '../data/sharing';
import { useFuelLog } from './fuelLog';

/**
 * Sharing one of your cars (#66): invite someone by their Google address, see
 * who it is shared with, remove them, or withdraw an invitation nobody has
 * answered.
 *
 * What sharing exposes is said here, before anybody is invited: the car's
 * whole history — receipt photos, notes and stations included — and that the
 * other person can add, correct and delete fill-ups on it. Nothing else of
 * yours is visible to them.
 */
export function SharePanel({ vehicle }: { readonly vehicle: VehicleRecord }): ReactElement {
  const { sharing } = useFuelLog();
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [pending, setPending] = useState<readonly Invite[]>([]);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const { membersOf, invitesSentFor } = sharing;
  const load = useCallback(async () => {
    try {
      const [who, waiting] = await Promise.all([membersOf(vehicle.id), invitesSentFor(vehicle.id)]);
      setMembers(who);
      setPending(waiting);
    } catch {
      setProblem('Who this car is shared with could not be loaded. Check your connection.');
    }
  }, [membersOf, invitesSentFor, vehicle.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function invite(event: FormEvent): Promise<void> {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    const address = normalizeEmail(email);
    if (address === null) {
      setProblem('That does not look like an email address.');
      return;
    }
    try {
      await sharing.invite(vehicle, address);
      setEmail('');
      setStatus(`Invited ${address}. They will be asked to accept the next time they open FuelTracker.`);
      await load();
    } catch {
      setProblem(
        `${address} could not be invited. They may already have an invitation for this car — withdraw it to send a new one.`,
      );
    }
  }

  async function act(work: () => Promise<void>, done: string): Promise<void> {
    setStatus(null);
    setProblem(null);
    try {
      await work();
      setStatus(done);
      await load();
    } catch {
      setProblem('That did not go through. Check your connection and try again.');
    }
  }

  return (
    <div className="space-above-sm">
      <p className="stack-sm">
        Someone you share {vehicle.name} with sees its whole history — including receipt photos, notes
        and stations — and can add, correct and delete its fill-ups. They see nothing else of yours.
      </p>
      {/* `noValidate`: the address is checked by `normalizeEmail`, so the
          message is the same plain sentence in every browser. */}
      <form noValidate onSubmit={(event) => void invite(event)}>
        <div className="field">
          <label className="field__label" htmlFor={`share-email-${vehicle.id}`}>
            Their Google email
          </label>
          <input
            id={`share-email-${vehicle.id}`}
            type="email"
            autoComplete="off"
            maxLength={MAX_EMAIL_LENGTH}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <button className="button" type="submit" disabled={email.trim() === ''}>
          Invite
        </button>
      </form>

      {members.length > 0 && (
        <ul className="list-plain space-above-sm" aria-label={`Shared with`}>
          {members.map((member) => (
            <li key={member.uid} className="row-actions align-center">
              <span>
                Shared with <strong>{verifiedName(member)}</strong>
              </span>
              <button
                className="button button--secondary"
                type="button"
                onClick={() =>
                  void act(() => sharing.removeMember(vehicle.id, member.uid), `${verifiedName(member)} no longer has ${vehicle.name}.`)
                }
              >
                Remove {verifiedName(member)}
              </button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && (
        <ul className="list-plain space-above-sm" aria-label="Waiting to accept">
          {pending.map((invitation) => (
            <li key={invitation.email} className="row-actions align-center">
              <span>Invited {invitation.email}, waiting for them to accept</span>
              <button
                className="button button--secondary"
                type="button"
                onClick={() =>
                  void act(() => sharing.withdrawInvite(vehicle.id, invitation.email), `Withdrew the invitation to ${invitation.email}.`)
                }
              >
                Withdraw {invitation.email}
              </button>
            </li>
          ))}
        </ul>
      )}

      {status !== null && (
        <p className="after-sm" role="status">
          {status}
        </p>
      )}
      {problem !== null && (
        <p className="warning after-sm" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
