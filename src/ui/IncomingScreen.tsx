import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeSubmission } from '../data/fillUpLink';
import type { ReceiveResult } from './fuelLog';
import { useFuelLog } from './fuelLog';
import { DoneButton, LinkScreen, linkProblemText } from './SubmitScreen';

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
 * The link is decoded to the bar an imported file is held to, then queued for
 * review — never written to the log. Receiving is idempotent: the submission
 * carries its own id, so the same link opened twice is received once.
 *
 * A car that is not here may simply not have arrived yet — a fresh device,
 * signed in a moment ago — so "no such car" is answered only after one sync.
 */
export function IncomingScreen({ payload, onReceived, onDone }: Props): ReactElement {
  const log = useFuelLog();
  const { receiveSubmission, selectVehicle } = log;
  const { syncNow } = log.sync;
  const decoded = useMemo(() => decodeSubmission(payload), [payload]);
  const [result, setResult] = useState<ReceiveResult | 'failed' | null>(null);
  // StrictMode mounts effects twice in development; receiving is idempotent,
  // but a second pass would turn "received" into "already received".
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!decoded.ok || started.current === payload) return;
    started.current = payload;
    const submission = decoded.value;
    void (async () => {
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
    })();
  }, [decoded, payload, receiveSubmission, syncNow, selectVehicle, onReceived]);

  if (!decoded.ok) {
    return (
      <LinkScreen title="Fill-up link">
        <p role="alert">{linkProblemText(decoded.problem, 'submission')}</p>
        <DoneButton onDone={onDone} />
      </LinkScreen>
    );
  }

  const from = decoded.value.submitterName || 'someone';
  return (
    <LinkScreen title="Fill-up link">
      {result === null || result === 'queued' ? (
        <p role="status">Receiving the fill-up from {from}…</p>
      ) : (
        <p role="alert">{receiveText(result)}</p>
      )}
      {result === 'duplicate' ? (
        <DoneButton onDone={onReceived} label="Go to fill-ups" />
      ) : (
        result !== null && <DoneButton onDone={onDone} />
      )}
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
