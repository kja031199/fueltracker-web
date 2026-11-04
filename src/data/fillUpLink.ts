/**
 * Fill-ups sent by link (#3): a **request** from the owner of a car, and a
 * **submission** back from whoever filled it up.
 *
 * ## The transport is the URL fragment
 *
 * Both live after the `#` — `#/submit/<payload>` and `#/incoming/<payload>` —
 * which browsers never send to any server. There is no server here to send
 * them to, and this keeps it that way: a link carries its fill-up from one
 * person's screen to another's through whatever they already use to talk.
 *
 * ## Untrusted, like an imported file
 *
 * Anyone can type a URL. So a link is decoded to the bar `recordValidation`
 * sets for a file: a length cap checked **before** anything is decoded, every
 * field type-checked, ids held to `isStorableId`, text bounded, the numbers
 * through `makeFuelEntryDraft`, and a date that is invalid, years in the
 * future or absurdly old refused. A submission still lands only in the
 * owner's review queue, and is checked once more when it is approved.
 *
 * ## Only what the submitter knows

"Missed the previous fill-up" is not carried: it is a fact about the owner's
log, which the submitter never sees, and the review queue has no place for it.

## Text only, and small
 *
 * No receipt photo (it would not fit) and no coordinates (nobody needs to
 * send their location by link). Text is shortened to `LINK_TEXT_LIMITS` on
 * the way out, so a link stays a few hundred characters — some messengers
 * mangle long URLs — and never exceeds `MAX_LINK_PAYLOAD`.
 *
 * ## Idempotent
 *
 * Each submission carries an id the submitter's device chose. Opening the same
 * link twice — it was pasted into two chats, or tapped twice — queues it once.
 */

import { isStorableId } from './recordId';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';
import { fuelGradeFromRaw } from '../domain/fuelGrade';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';

/** The current link format. A higher one is from a newer build. */
export const LINK_VERSION = 1;

/** Longest payload accepted, in characters, checked before decoding. */
export const MAX_LINK_PAYLOAD = 4096;

/** Text limits inside a link: tighter than storage, so links stay short. */
export const LINK_TEXT_LIMITS = {
  vehicleName: TEXT_LIMITS.vehicleName,
  ownerName: TEXT_LIMITS.ownerName,
  submitterName: 100,
  station: 100,
  notes: 280,
} as const;

/** Dates before this are a misread or a crafted link, not a fill-up. */
const EARLIEST_DATE = new Date(1990, 0, 1).getTime();
/** A day of slack ahead of now: time zones and wrong clocks, not the future. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export interface FillUpRequest {
  readonly vehicleId: string;
  readonly vehicleName: string;
  readonly ownerName: string;
}

export interface Submission {
  /** Chosen by the submitter's device; what makes receiving idempotent. */
  readonly id: string;
  readonly vehicleId: string;
  readonly submitterName: string;
  readonly submittedAt: number;
  readonly draft: FuelEntryDraft;
}

export type LinkProblem = 'too-long' | 'damaged' | 'wrong-kind' | 'newer-version' | 'invalid';

export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: LinkProblem };

// --- base64url over UTF-8 JSON ----------------------------------------------

function encode(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The payload's object, or a problem. Never throws. */
function decode(payload: string): Record<string, unknown> | LinkProblem {
  if (payload.length > MAX_LINK_PAYLOAD) return 'too-long';
  if (payload === '' || !/^[A-Za-z0-9_-]+$/.test(payload)) return 'damaged';
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'damaged';
    return parsed as Record<string, unknown>;
  } catch {
    return 'damaged';
  }
}

function kindOf(value: Record<string, unknown>, kind: string): LinkProblem | null {
  const version = value['v'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return 'damaged';
  if (version > LINK_VERSION) return 'newer-version';
  return value['k'] === kind ? null : 'wrong-kind';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? boundText(value, max) : '';
}

// --- Requests -----------------------------------------------------------------

export function encodeRequest(request: FillUpRequest): string {
  return encode({
    v: LINK_VERSION,
    k: 'req',
    car: request.vehicleId,
    name: boundText(request.vehicleName, LINK_TEXT_LIMITS.vehicleName),
    from: boundText(request.ownerName, LINK_TEXT_LIMITS.ownerName),
  });
}

export function decodeRequest(payload: string): Decoded<FillUpRequest> {
  const value = decode(payload);
  if (typeof value === 'string') return { ok: false, problem: value };
  const kind = kindOf(value, 'req');
  if (kind !== null) return { ok: false, problem: kind };
  if (!isStorableId(value['car'])) return { ok: false, problem: 'invalid' };
  return {
    ok: true,
    value: {
      vehicleId: value['car'],
      vehicleName: text(value['name'], LINK_TEXT_LIMITS.vehicleName),
      ownerName: text(value['from'], LINK_TEXT_LIMITS.ownerName),
    },
  };
}

// --- Submissions ----------------------------------------------------------------

export function encodeSubmission(submission: Submission): string {
  const { draft } = submission;
  return encode({
    v: LINK_VERSION,
    k: 'sub',
    id: submission.id,
    car: submission.vehicleId,
    by: boundText(submission.submitterName, LINK_TEXT_LIMITS.submitterName),
    at: submission.submittedAt,
    d: draft.date.getTime(),
    o: draft.odometer,
    g: draft.gallons,
    p: draft.pricePerGallon,
    f: draft.isFullTank,
    gr: draft.fuelGrade,
    s: boundText(draft.station, LINK_TEXT_LIMITS.station),
    n: boundText(draft.notes, LINK_TEXT_LIMITS.notes),
  });
}

export function decodeSubmission(payload: string, now: number = Date.now()): Decoded<Submission> {
  const value = decode(payload);
  if (typeof value === 'string') return { ok: false, problem: value };
  const kind = kindOf(value, 'sub');
  if (kind !== null) return { ok: false, problem: kind };

  const invalid = { ok: false, problem: 'invalid' } as const;
  const id = value['id'];
  const car = value['car'];
  if (!isStorableId(id) || !isStorableId(car)) return invalid;

  const date = value['d'];
  if (typeof date !== 'number' || !Number.isFinite(date)) return invalid;
  if (date < EARLIEST_DATE || date > now + FUTURE_SLACK_MS) return invalid;

  const full = value['f'];
  if (full !== undefined && typeof full !== 'boolean') return invalid;

  const number = (field: unknown): number | null => (typeof field === 'number' ? field : null);
  const draft = makeFuelEntryDraft({
    date: new Date(date),
    odometer: number(value['o']),
    gallons: number(value['g']),
    pricePerGallon: number(value['p']),
    isFullTank: full ?? true,
    // Not carried: whether the fill-up before this one went unlogged is a fact
    // about the owner's log, which the submitter never sees. The owner can
    // mark it after approving.
    missedPreviousFillUp: false,
    fuelGrade: fuelGradeFromRaw(typeof value['gr'] === 'string' ? value['gr'] : ''),
    station: text(value['s'], LINK_TEXT_LIMITS.station),
    notes: text(value['n'], LINK_TEXT_LIMITS.notes),
    // Text only: a link never carries a photo or a place.
    latitude: null,
    longitude: null,
    receiptImageData: null,
  });
  if (draft === null) return invalid;

  const at = value['at'];
  return {
    ok: true,
    value: {
      id,
      vehicleId: car,
      submitterName: text(value['by'], LINK_TEXT_LIMITS.submitterName),
      // When it was sent is a courtesy: junk reads as now, not as a refusal.
      submittedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now + FUTURE_SLACK_MS ? at : now,
      draft,
    },
  };
}

// --- Whole links --------------------------------------------------------------

/** `https://…/#/submit/<payload>` for the page at `base` (origin + path). */
export function requestUrl(base: string, request: FillUpRequest): string {
  return `${base}#/submit/${encodeRequest(request)}`;
}

/** `https://…/#/incoming/<payload>`. */
export function submissionUrl(base: string, submission: Submission): string {
  return `${base}#/incoming/${encodeSubmission(submission)}`;
}
