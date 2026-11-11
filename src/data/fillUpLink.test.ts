import { describe, expect, test } from 'vitest';
import {
  LINK_TEXT_LIMITS,
  MAX_LINK_PAYLOAD,
  decodeRequest,
  decodeSubmission,
  encodeRequest,
  encodeSubmission,
  type FillUpRequest,
  type Submission,
} from './fillUpLink';
import { makeFuelEntryDraft } from '../domain/fuelEntryDraft';

/**
 * The two links of #3: a request (owner → submitter) and a submission
 * (submitter → owner). Everything that arrives in a link is untrusted — anyone
 * can type a URL — so decoding is held to the same bar as an imported file.
 */

const NOW = new Date(2026, 10, 1).getTime();

const REQUEST: FillUpRequest = { vehicleId: 'car-123', vehicleName: 'Civic', ownerName: 'Kyle' };

function submission(overrides: Partial<Submission> = {}): Submission {
  const draft = makeFuelEntryDraft({
    date: new Date(2026, 9, 30, 8, 15),
    odometer: 10_300.5,
    gallons: 9.876,
    pricePerGallon: 3.499,
    isFullTank: true,
    fuelGrade: 'Premium',
    station: 'Shell',
    notes: 'Filled after the trip',
  });
  if (draft === null) throw new Error('fixture draft failed validation');
  return {
    id: 'sub-1',
    vehicleId: 'car-123',
    submitterName: 'Sam',
    submittedAt: NOW - 1000,
    draft,
    ...overrides,
  };
}

/** base64url of arbitrary JSON, for planting hostile payloads. */
function raw(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const validSubmissionObject = (): Record<string, unknown> => {
  const decoded = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(encodeSubmission(submission()).replaceAll('-', '+').replaceAll('_', '/')), (c) =>
        c.charCodeAt(0),
      ),
    ),
  ) as Record<string, unknown>;
  return decoded;
};

describe('a request link', () => {
  test('round-trips', () => {
    const decoded = decodeRequest(encodeRequest(REQUEST));
    expect(decoded).toEqual({ ok: true, value: REQUEST });
  });

  test('is URL-safe as it stands — no +, /, = or spaces', () => {
    const payload = encodeRequest({ ...REQUEST, vehicleName: 'Café ✓ / + = ?' });
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRequest(payload)).toEqual({ ok: true, value: { ...REQUEST, vehicleName: 'Café ✓ / + = ?' } });
  });

  test('a submission link is not a request', () => {
    expect(decodeRequest(encodeSubmission(submission()))).toEqual({ ok: false, problem: 'wrong-kind' });
  });

  test.each([
    ['an unstorable car id', { v: 1, k: 'req', car: '../x', name: 'C', from: 'K' }],
    ['an empty car id', { v: 1, k: 'req', car: '', name: 'C', from: 'K' }],
    ['a car id that is not text', { v: 1, k: 'req', car: 42, name: 'C', from: 'K' }],
    ['no car at all', { v: 1, k: 'req', name: 'C', from: 'K' }],
  ])('refuses %s', (_label, value) => {
    expect(decodeRequest(raw(value))).toEqual({ ok: false, problem: 'invalid' });
  });

  test('missing or junk names become empty rather than refusing the link', () => {
    expect(decodeRequest(raw({ v: 1, k: 'req', car: 'car-1', name: 7, from: null }))).toEqual({
      ok: true,
      value: { vehicleId: 'car-1', vehicleName: '', ownerName: '' },
    });
  });
});

describe('a submission link', () => {
  test('round-trips every field the owner will review', () => {
    const decoded = decodeSubmission(encodeSubmission(submission()), NOW);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const { draft, ...rest } = decoded.value;
    expect(rest).toEqual({ id: 'sub-1', vehicleId: 'car-123', submitterName: 'Sam', submittedAt: NOW - 1000 });
    expect(draft.date.getTime()).toBe(new Date(2026, 9, 30, 8, 15).getTime());
    expect(draft).toMatchObject({
      odometer: 10_300.5,
      gallons: 9.876,
      pricePerGallon: 3.499,
      isFullTank: true,
      missedPreviousFillUp: false,
      fuelGrade: 'Premium',
      station: 'Shell',
      notes: 'Filled after the trip',
    });
  });

  test('carries text only — never a photo or a location', () => {
    const withExtras = submission({
      draft: { ...submission().draft, latitude: 40.8, longitude: -96.7, receiptImageData: new Uint8Array([1, 2, 3]) },
    });
    const decoded = decodeSubmission(encodeSubmission(withExtras), NOW);
    expect(decoded.ok && decoded.value.draft).toMatchObject({
      latitude: null,
      longitude: null,
      receiptImageData: null,
    });
  });

  test('"missed the previous fill-up" is the owner’s to say, so a link never carries it', () => {
    const marked = submission({ draft: { ...submission().draft, missedPreviousFillUp: true } });
    const decoded = decodeSubmission(encodeSubmission(marked), NOW);
    expect(decoded.ok && decoded.value.draft.missedPreviousFillUp).toBe(false);
    const planted = decodeSubmission(raw({ ...validSubmissionObject(), m: true }), NOW);
    expect(planted.ok && planted.value.draft.missedPreviousFillUp).toBe(false);
  });

  test('a typical link is short enough to paste into any chat', () => {
    expect(encodeSubmission(submission()).length).toBeLessThan(600);
  });

  test('even with every text field at its link limit, it stays under the cap', () => {
    const long = submission({
      submitterName: 'n'.repeat(LINK_TEXT_LIMITS.submitterName),
      draft: {
        ...submission().draft,
        station: 's'.repeat(LINK_TEXT_LIMITS.station),
        notes: 'x'.repeat(LINK_TEXT_LIMITS.notes),
      },
    });
    expect(encodeSubmission(long).length).toBeLessThanOrEqual(MAX_LINK_PAYLOAD);
  });

  test('longer text is shortened on the way out, so the link never breaks the cap', () => {
    const essay = submission({ draft: { ...submission().draft, notes: 'x'.repeat(50_000) } });
    const payload = encodeSubmission(essay);
    expect(payload.length).toBeLessThanOrEqual(MAX_LINK_PAYLOAD);
    const decoded = decodeSubmission(payload, NOW);
    expect(decoded.ok && decoded.value.draft.notes.length).toBe(LINK_TEXT_LIMITS.notes);
  });

  test('an unknown grade reads as Other, as everywhere else', () => {
    const decoded = decodeSubmission(raw({ ...validSubmissionObject(), gr: 'Rocket fuel' }), NOW);
    expect(decoded.ok && decoded.value.draft.fuelGrade).toBe('Other');
  });

  test('a request link is not a submission', () => {
    expect(decodeSubmission(encodeRequest(REQUEST), NOW)).toEqual({ ok: false, problem: 'wrong-kind' });
  });
});

describe('a damaged or hostile link', () => {
  test.each([
    ['empty', ''],
    ['not base64url', 'this is not a link!'],
    ['truncated mid-way', encodeSubmission(submission()).slice(0, 40)],
    ['base64 of something that is not JSON', btoa('not json')],
    ['JSON that is not an object', raw([1, 2, 3])],
    ['JSON null', raw(null)],
    ['invalid UTF-8', btoa(String.fromCharCode(0xff, 0xfe, 0xfd)).replace(/=+$/, '')],
  ])('%s is damaged', (_label, payload) => {
    expect(decodeSubmission(payload, NOW)).toEqual({ ok: false, problem: 'damaged' });
    expect(decodeRequest(payload)).toEqual({ ok: false, problem: 'damaged' });
  });

  test('standard base64 — with + or / — is not a link: links are base64url only', () => {
    // Characters chosen so the standard alphabet's + and / both appear.
    const standard = btoa(JSON.stringify({ v: 1, k: 'req', car: 'car-1', name: '>>>???~~~' })).replace(/=+$/, '');
    expect(standard).toMatch(/[+/]/);
    expect(decodeRequest(standard)).toEqual({ ok: false, problem: 'damaged' });
  });

  test('JSON carrying a byte that is not UTF-8 is damaged, not read with a replacement character', () => {
    const head = new TextEncoder().encode('{"v":1,"k":"req","car":"car-1","name":"');
    const tail = new TextEncoder().encode('"}');
    const bytes = [...head, 0xff, ...tail];
    const payload = btoa(String.fromCharCode(...bytes))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(decodeRequest(payload)).toEqual({ ok: false, problem: 'damaged' });
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['a year ahead', NOW + 365 * 86_400_000],
    ['infinite, as JSON cannot say', 'Infinity'],
  ])('a submittedAt that is %s becomes now', (_label, at) => {
    const decoded = decodeSubmission(raw({ ...validSubmissionObject(), at }), NOW);
    expect(decoded.ok && decoded.value.submittedAt).toBe(NOW);
  });

  test('text over the link limit but under the cap is cut to the limit', () => {
    const payload = raw({ ...validSubmissionObject(), by: 'n'.repeat(150), s: 's'.repeat(150), n: 'x'.repeat(400) });
    expect(payload.length).toBeLessThanOrEqual(MAX_LINK_PAYLOAD);
    const decoded = decodeSubmission(payload, NOW);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.submitterName).toHaveLength(LINK_TEXT_LIMITS.submitterName);
    expect(decoded.value.draft.station).toHaveLength(LINK_TEXT_LIMITS.station);
    expect(decoded.value.draft.notes).toHaveLength(LINK_TEXT_LIMITS.notes);
  });

  test('anything over the cap is refused before it is decoded', () => {
    const huge = 'A'.repeat(MAX_LINK_PAYLOAD + 1);
    expect(decodeSubmission(huge, NOW)).toEqual({ ok: false, problem: 'too-long' });
    expect(decodeRequest(huge)).toEqual({ ok: false, problem: 'too-long' });
  });

  test('a newer version is named as such, so the reader knows to update', () => {
    expect(decodeSubmission(raw({ ...validSubmissionObject(), v: 2 }), NOW)).toEqual({
      ok: false,
      problem: 'newer-version',
    });
    expect(decodeRequest(raw({ v: 9, k: 'req', car: 'c' }))).toEqual({ ok: false, problem: 'newer-version' });
  });

  test.each([
    ['a version that is not a number', { v: 'one' }],
    ['version 0', { v: 0 }],
  ])('%s is damaged', (_label, patch) => {
    expect(decodeSubmission(raw({ ...validSubmissionObject(), ...patch }), NOW).ok).toBe(false);
  });

  test.each([
    ['zero gallons', { g: 0 }],
    ['negative odometer', { o: -5 }],
    ['a price written as text', { p: '3.49' }],
    ['NaN, as JSON cannot carry it', { g: 'NaN' }],
    ['an absurd number', { o: 1e309 }],
    ['no date', { d: undefined }],
    ['a date that is not a number', { d: 'yesterday' }],
    ['a date years in the future', { d: NOW + 400 * 86_400_000 }],
    ['a date before cars had odometers worth logging', { d: new Date(1950, 0, 1).getTime() }],
    ['an unstorable submission id', { id: '__proto__' }],
    ['no submission id', { id: undefined }],
    ['an unstorable car id', { car: 'a/b' }],
    ['full tank as text', { f: 'yes' }],
  ])('refuses %s', (_label, patch) => {
    const value = { ...validSubmissionObject(), ...patch };
    expect(decodeSubmission(raw(value), NOW)).toEqual({ ok: false, problem: 'invalid' });
  });

  test('a date a few hours ahead — another time zone, a clock off — is accepted', () => {
    expect(decodeSubmission(raw({ ...validSubmissionObject(), d: NOW + 6 * 3_600_000 }), NOW).ok).toBe(true);
  });

  test('a submittedAt that is junk becomes now, rather than refusing a good fill-up', () => {
    const decoded = decodeSubmission(raw({ ...validSubmissionObject(), at: 'soon' }), NOW);
    expect(decoded.ok && decoded.value.submittedAt).toBe(NOW);
  });

  test('extra fields, including prototype-shaped ones, are ignored', () => {
    const decoded = decodeSubmission(
      raw({ ...validSubmissionObject(), __proto__: { polluted: true }, constructor: 'x', extra: 'y' }),
      NOW,
    );
    expect(decoded.ok).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('text from a link is bounded however it was crafted', () => {
    const decoded = decodeSubmission(
      raw({ ...validSubmissionObject(), by: 'n'.repeat(3000), s: 's'.repeat(3000) }),
      NOW,
    );
    // Over the payload cap? Then it is refused outright; otherwise bounded.
    if (decoded.ok) {
      expect(decoded.value.submitterName.length).toBeLessThanOrEqual(LINK_TEXT_LIMITS.submitterName);
      expect(decoded.value.draft.station.length).toBeLessThanOrEqual(LINK_TEXT_LIMITS.station);
    } else {
      expect(decoded.problem).toBe('too-long');
    }
  });

  test('text that is not text becomes empty', () => {
    const decoded = decodeSubmission(raw({ ...validSubmissionObject(), s: { nested: true }, n: 42, by: null }), NOW);
    expect(decoded.ok && [decoded.value.draft.station, decoded.value.draft.notes, decoded.value.submitterName]).toEqual(
      ['', '', ''],
    );
  });
});
