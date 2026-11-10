import type { ReactElement } from 'react';
import { useMemo, useRef, useState } from 'react';
import { decodeSubmission } from '../data/fillUpLink';
import { fillUpFacts } from '../domain/format';
import { totalCost } from '../domain/models';
import { FillUpSummary } from './FillUpSummary';
import type { ReceiveResult } from './fuelLog';
import { useFuelLog, useSyncStatus } from './fuelLog';
import { DoneButton, LinkScreen } from './LinkScreen';
import { linkProblemText } from './linkMessages';
import { useUnits } from './session';

interface Props {
  /** The submission link's payload, as the address carried it. */
  readonly payload: string;
  /** Received: show it waiting for review. */
  readonly onReceived: () => void;
  /** Leave the link for the app. */
  readonly onDone: () => void;
}

/**
 * Opening a fill-up somebody sent back (#3).
 *
 * The link is decoded to the bar an imported file is held to and **shown**;
 * it is queued for review only when the owner presses Queue for review (#81).
 * It used to be queued on open — so anyone who knew a car's id could fill the
 * owner's review list with links, each one a write and a sync, without the
 * owner doing anything but tapping. Nothing is ever written to the log here.
 *
 * Receiving is idempotent: the submission carries its own id, so the same link
 * queued twice is received once. A car that is not here may simply not have
 * arrived yet — a fresh device, signed in a moment ago — so "no such car" is
 * answered only after one sync.
 *
 * The submitter's name is whatever they typed, so it is shown as a claim.
 */
export function IncomingScreen({ payload, onReceived, onDone }: Props): ReactElement {
  const log = useFuelLog();
  const { receiveSubmission, selectVehicle, vehicles } = log;
  const { syncNow } = useSyncStatus();
  const { units } = useUnits();
  const decoded = useMemo(() => decodeSubmission(payload), [payload]);
  const [result, setResult] = useState<ReceiveResult | 'failed' | 'receiving' | null>(null);
  // One receive per link, however many times the button is pressed before the
  // first press has finished.
  const started = useRef<string | null>(null);

  if (!decoded.ok) {
    return (
      <LinkScreen title="Fill-up link">
        <p role="alert">{linkProblemText(decoded.problem, 'submission')}</p>
        <DoneButton onDone={onDone} />
      </LinkScreen>
    );
  }

  const submission = decoded.value;
  const { draft } = submission;
  const car = vehicles.find((vehicle) => vehicle.id === submission.vehicleId);
  const name = submission.submitterName.trim();
  const from = name === '' ? 'Someone sent you this fill-up.' : `Someone who says they are ${name} sent you this fill-up.`;

  async function queue(): Promise<void> {
    if (started.current === payload) return;
    started.current = payload;
    setResult('receiving');
    try {
      let outcome = await receiveSubmission(submission);
      if (outcome === 'no-such-car') {
        await syncNow();
        outcome = await receiveSubmission(submission);
      }
      if (outcome === 'queued') {
        selectVehicle(submission.vehicleId);
        onReceived();
        return;
      }
      setResult(outcome);
    } catch {
      setResult('failed');
    }
  }

  if (result !== null && result !== 'receiving' && result !== 'queued') {
    return (
      <LinkScreen title="Fill-up link">
        <p role="alert">{receiveText(result)}</p>
        {result === 'duplicate' ? (
          <DoneButton onDone={onReceived} label="Go to fill-ups" />
        ) : (
          <DoneButton onDone={onDone} />
        )}
      </LinkScreen>
    );
  }

  return (
    <LinkScreen title="Fill-up link">
      <p>{from}</p>
      <p className="note">
        A name in a link is whatever its sender typed. Queue it only if you know who sent it — nothing is added to
        your log until you approve it.
      </p>
      <FillUpSummary
        title={car?.name ?? 'A car not in your log'}
        subtitle={draft.date.toLocaleDateString()}
        facts={[...fillUpFacts(draft, units), ...(draft.station === '' ? [] : [draft.station])]}
        notes={draft.notes}
        cost={totalCost(draft)}
      />
      {result === 'receiving' && <p role="status">Queuing the fill-up for review…</p>}
      <div className="row-actions space-above-sm">
        <button className="button" type="button" disabled={result === 'receiving'} onClick={() => void queue()}>
          Queue for review
        </button>
        <button className="button button--secondary" type="button" onClick={onDone}>
          Ignore
        </button>
      </div>
    </LinkScreen>
  );
}

function receiveText(result: Exclude<ReceiveResult, 'queued'> | 'failed'): string {
  switch (result) {
    case 'duplicate':
      return 'You have already received this fill-up. Opening the link again does not add it twice.';
    case 'no-such-car':
      return 'The car this fill-up is for is not in your log — it may have been deleted, or the link was meant for someone else.';
    case 'not-yours':
      return 'This fill-up is for a car that is shared with you, not one of yours. Send the link to the car’s owner to review.';
    case 'failed':
      return 'The fill-up could not be saved for review — storage on this device refused it. Try opening the link again.';
  }
}
