import type { ReactElement, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import type { LinkProblem } from '../data/fillUpLink';
import { LINK_TEXT_LIMITS, decodeRequest, submissionUrl } from '../data/fillUpLink';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import type { UnitPreferences } from '../domain/units';
import { boundText } from '../domain/textLimits';
import { FillUpForm } from './FillUpForm';
import { LinkOut, appBase } from './LinkOut';

interface Props {
  /** The request link's payload, as the address carried it. */
  readonly payload: string;
  /** Pre-fills "Your name": the signed-in account's display name. */
  readonly accountName: string;
  readonly units: UnitPreferences;
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
export function SubmitScreen({ payload, accountName, units, onDone }: Props): ReactElement {
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
        units={units}
        existing={[]}
        editing={null}
        onSaved={async () => {}}
        onCancel={onDone}
        forLink={{ title: `Fill-up for ${car}`, onDraft: makeLink }}
      />
    </LinkScreen>
  );
}

/** What went wrong with a link, said so its reader knows what to do next. */
export function linkProblemText(problem: LinkProblem, kind: 'request' | 'submission'): string {
  const ask = kind === 'request' ? 'Ask for the request to be sent again.' : 'Ask for it to be sent again.';
  switch (problem) {
    case 'too-long':
      return `This link is far longer than a fill-up link can be, so it was not read. ${ask}`;
    case 'damaged':
      return `This link is damaged — part of it was probably lost when it was copied. ${ask}`;
    case 'wrong-kind':
      return kind === 'request'
        ? 'This is not a fill-up request link.'
        : 'This is not a fill-up link.';
    case 'newer-version':
      return 'This link was made by a newer version of FuelTracker. Reload the page to update, then open the link again.';
    case 'invalid':
      return kind === 'request'
        ? `This request does not name a car that can be logged. ${ask}`
        : `The fill-up in this link does not add up — a number or the date is impossible — so it was not received. ${ask}`;
  }
}

export function LinkScreen({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="app">
      <h1 className="app__title">FuelTracker</h1>
      <main className="app__main">
        <section className="card" aria-labelledby="link-screen-heading">
          <h2 className="card__title" id="link-screen-heading">
            {title}
          </h2>
          {children}
        </section>
      </main>
    </div>
  );
}

export function DoneButton({ onDone, label = 'Go to FuelTracker' }: { readonly onDone: () => void; readonly label?: string }): ReactElement {
  return (
    <button className="button button--secondary" type="button" onClick={onDone}>
      {label}
    </button>
  );
}
