/**
 * Everything this app keeps in web storage, through one door (#55).
 *
 * ## Two scopes, declared rather than remembered
 *
 * Local *data* has been separate per account since #44: each signed-in uid gets
 * its own IndexedDB. Local *state* was not. Every `localStorage` key was
 * browser-wide, so on a shared device:
 *
 * - account B's backup reminder compared B's fill-ups with **A's** last export,
 *   and could stay silent while B held data that existed nowhere else — the
 *   outcome the reminder exists to prevent;
 * - Settings showed B the time of A's last sync;
 * - B was never welcomed, because A had already been.
 *
 * So every key now says which it is:
 *
 * - **`browser`** — about this device, whoever is using it: units, the idle
 *   sign-out setting and its activity marker, the CSP watcher. Stored under
 *   `fueltracker.<name>`, the names these always had, so existing settings
 *   survive.
 * - **`account`** — about one person's fuel log: the backup marker, the last
 *   sync time, whether they have been welcomed. Stored under
 *   `fueltracker.<name>.u.<uid>`. The name comes first and the uid is the
 *   whole remainder, so no uid can produce another account's key.
 *
 * An account preference needs a uid to read or write at all; without one (not
 * signed in, or a uid that is empty or longer than Firebase allows) it reads as
 * absent and writes nothing. The type system makes the uid a required argument,
 * so it cannot be forgotten, only passed as `null` on purpose.
 *
 * ## Values from before the split are dropped, not adopted
 *
 * An unscoped `fueltracker.lastBackup` could have been written by anyone who
 * ever used this browser. Adopting it would hand one account's state to
 * whoever signs in next — the #44 mistake again. So the first read or write of
 * an account preference deletes the unscoped key. The cost is one extra prompt:
 * a backup reminder may show once, and "Last synced" reads "not yet" until the
 * sync that runs on sign-in. Both err towards telling the reader too much.
 *
 * ## Every failure is an absent value
 *
 * Storage can be unreachable (some browsers throw on *touching*
 * `window.localStorage` with cookies off), refuse a write (private mode, a full
 * quota), or hold anything at all (hand-edited, or written by an older build).
 * None of that is worth taking the app down over, so a read that fails for any
 * reason returns `null` and the caller applies its own fallback; a write
 * reports whether it stuck. `src/test/storageBoundary.test.ts` checks that no
 * other module touches web storage, so these rules hold everywhere.
 */

import { useCallback, useState } from 'react';

export type PreferenceScope = 'browser' | 'account';

/** How a value is written as text and read back. `decode` returns null for junk. */
export interface Codec<T> {
  readonly decode: (raw: string) => T | null;
  readonly encode: (value: T) => string;
}

interface Preference<T, S extends PreferenceScope> extends Codec<T> {
  readonly name: string;
  readonly scope: S;
}

export type BrowserPreference<T> = Preference<T, 'browser'>;
export type AccountPreference<T> = Preference<T, 'account'>;

const PREFIX = 'fueltracker.';

/** Firebase's own ceiling on a uid's length. Anything longer is not a real one. */
export const MAX_UID_LENGTH = 128;

export function browserPreference<T>(name: string, codec: Codec<T>): BrowserPreference<T> {
  return { name, scope: 'browser', ...codec };
}

export function accountPreference<T>(name: string, codec: Codec<T>): AccountPreference<T> {
  return { name, scope: 'account', ...codec };
}

// --- Codecs ------------------------------------------------------------------

/** JSON, kept only when it has the expected shape. */
export function jsonCodec<T>(isValid: (value: unknown) => value is T): Codec<T> {
  return {
    decode: (raw) => {
      const parsed: unknown = JSON.parse(raw);
      return isValid(parsed) ? parsed : null;
    },
    encode: (value) => JSON.stringify(value),
  };
}

/** A finite number. `NaN`, the infinities and empty text are all junk. */
export const numberCodec: Codec<number> = {
  decode: (raw) => {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  },
  encode: (value) => String(value),
};

/**
 * A flag that is set by exactly one spelling, and otherwise absent — so a
 * caller's fallback decides what "not set" means. Writing `false` stores text
 * that reads back as absent; removing the preference is the cleaner way off.
 */
export function flagCodec(on: string): Codec<boolean> {
  return {
    decode: (raw) => (raw === on ? true : null),
    encode: (value) => (value ? on : ''),
  };
}

// --- Keys --------------------------------------------------------------------

function isUsableUid(uid: string | null): uid is string {
  return uid !== null && uid.length > 0 && uid.length <= MAX_UID_LENGTH;
}

function unscopedKey<T>(preference: Preference<T, PreferenceScope>): string {
  return `${PREFIX}${preference.name}`;
}

export function storageKey<T>(preference: BrowserPreference<T>): string;
export function storageKey<T>(preference: AccountPreference<T>, uid: string | null): string | null;
export function storageKey<T>(preference: Preference<T, PreferenceScope>, uid: string | null = null): string | null {
  if (preference.scope === 'browser') return unscopedKey(preference);
  return isUsableUid(uid) ? `${unscopedKey(preference)}.u.${uid}` : null;
}

// --- The one place web storage is touched -------------------------------------

/** `window.localStorage`, or null where even reaching it throws. */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Drops an account preference's pre-#55 unscoped value. Never throws. */
function forgetUnscoped<T>(preference: Preference<T, PreferenceScope>): void {
  if (preference.scope !== 'account') return;
  try {
    storage()?.removeItem(unscopedKey(preference));
  } catch {
    // Nothing depends on it: the unscoped value is never read either way.
  }
}

export function readPreference<T>(preference: BrowserPreference<T>): T | null;
export function readPreference<T>(preference: AccountPreference<T>, uid: string | null): T | null;
export function readPreference<T>(preference: Preference<T, PreferenceScope>, uid: string | null = null): T | null {
  forgetUnscoped(preference);
  const key = storageKey(preference as AccountPreference<T>, uid);
  if (key === null) return null;
  try {
    const raw = storage()?.getItem(key) ?? null;
    return raw === null ? null : preference.decode(raw);
  } catch {
    return null;
  }
}

/** True when the value was stored; false when there is no account or no room. */
export function writePreference<T>(preference: BrowserPreference<T>, value: T): boolean;
export function writePreference<T>(preference: AccountPreference<T>, value: T, uid: string | null): boolean;
export function writePreference<T>(
  preference: Preference<T, PreferenceScope>,
  value: T,
  uid: string | null = null,
): boolean {
  forgetUnscoped(preference);
  const key = storageKey(preference as AccountPreference<T>, uid);
  const store = storage();
  if (key === null || store === null) return false;
  try {
    store.setItem(key, preference.encode(value));
    return true;
  } catch {
    return false;
  }
}

export function removePreference<T>(preference: BrowserPreference<T>): void;
export function removePreference<T>(preference: AccountPreference<T>, uid: string | null): void;
export function removePreference<T>(preference: Preference<T, PreferenceScope>, uid: string | null = null): void {
  forgetUnscoped(preference);
  const key = storageKey(preference as AccountPreference<T>, uid);
  if (key === null) return;
  try {
    storage()?.removeItem(key);
  } catch {
    // Storage blocked: there is nothing stored to remove.
  }
}

// --- React --------------------------------------------------------------------

/**
 * An account preference as React state: read for `uid`, re-read whenever `uid`
 * changes, and stored for that account when set.
 *
 * The re-read happens during render rather than in an effect, so there is no
 * frame in which a new account is shown the previous one's value.
 */
export function useAccountPreference<T, F = T>(
  preference: AccountPreference<T>,
  uid: string | null,
  fallback: F,
): readonly [T | F, (next: T) => void] {
  const load = (): { uid: string | null; value: T | F } => ({
    uid,
    value: readPreference(preference, uid) ?? fallback,
  });
  const [entry, setEntry] = useState(load);
  let current = entry;
  if (entry.uid !== uid) {
    current = load();
    setEntry(current);
  }

  const set = useCallback(
    (value: T) => {
      setEntry({ uid, value });
      writePreference(preference, value, uid);
    },
    [preference, uid],
  );

  return [current.value, set] as const;
}
