import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';
import { LINK_TEXT_LIMITS, decodeRequest, submissionUrl } from '../data/fillUpLink';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { boundText } from '../domain/textLimits';
import { FillUpForm } from './FillUpForm';
import { LinkOut, appBase } from './LinkOut';
import { DoneButton, LinkScreen } from './LinkScreen';
import { linkProblemText } from './linkMessages';

interface Props {
  /** The request link's payload, as the address carried it. */
  readonly payload: string;
  /** Pre-fills "Your name": the signed-in account's display name. */
  readonly accountName: string;
  /** Leave the link for the app. */
  readonly onDone: () => void;
}

/**
 * Filling in a fill-up somebody asked for (#3): opened from their request
 * link, it produces a submission link to send back.
 *
 * **Nothing is written to this reader's log.** The car is not theirs and is
 * not on this device; the fill-up exists only in the link it makes, until its
 * owner opens that link and approves it.
 *
 * Each visit mints one submission id, which is what makes receiving it
 * idempotent: the same link opened twice, or pasted into two chats, is queued
 * once.
 */
export function SubmitScreen({ payload, accountName, onDone }: Props): ReactElement {
  const request = useMemo(() => decodeRequest(payload), [payload]);
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(() => boundText(accountName, LINK_TEXT_LIMITS.submitterName));
  const [url, setUrl] = useState<string | null>(null);

  if (!request.ok) {
    return (
      <LinkScreen title="Fill-up request">
        <p role="alert">{linkProblemText(request.problem, 'request')}</p>
        <DoneButton onDone={onDone} />
      </LinkScreen>
    );
  }

  const { vehicleId, vehicleName, ownerName } = request.value;
  const car = vehicleName || 'their car';
  const owner = ownerName || 'The owner';

  if (url !== null) {
    return (
      <LinkScreen title="Send this back">
        <p>
          Send this link to {ownerName || 'the car’s owner'}. When they open it, the fill-up waits for them
          to review — nothing is added to their log until they approve it.
        </p>
        <LinkOut url={url} label={`Fill-up for ${car}`} />
        <DoneButton onDone={onDone} />
      </LinkScreen>
    );
  }

  async function makeLink(draft: FuelEntryDraft): Promise<void> {
    setUrl(
      submissionUrl(appBase(), {
        id,
        vehicleId,
        submitterName: name.trim(),
        submittedAt: Date.now(),
        draft,
      }),
    );
  }

  return (
    <LinkScreen title="Fill-up request">
      <p>
        {owner} asked you to log a fill-up for <strong>{car}</strong>. Fill it in and you will get a link to
        send back. Nothing is saved to your own log.
      </p>
      <div className="field">
        <label className="field__label" htmlFor="submitter-name">
          Your name
        </label>
        <input
          id="submitter-name"
          maxLength={LINK_TEXT_LIMITS.submitterName}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <FillUpForm
        vehicleId={vehicleId}
        existing={[]}
        editing={null}
        onSaved={async () => {}}
        onCancel={onDone}
        forLink={{ title: `Fill-up for ${car}`, onDraft: makeLink }}
      />
    </LinkScreen>
  );
}
