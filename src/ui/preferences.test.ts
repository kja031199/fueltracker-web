// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  MAX_UID_LENGTH,
  accountPreference,
  browserPreference,
  flagCodec,
  jsonCodec,
  numberCodec,
  readPreference,
  removePreference,
  storageKey,
  useAccountPreference,
  writePreference,
} from './preferences';

const isPoint = (value: unknown): value is { x: number } =>
  typeof value === 'object' && value !== null && typeof (value as { x?: unknown }).x === 'number';

const UNITS = browserPreference('units', jsonCodec(isPoint));
const LAST = accountPreference('lastSyncedAt', numberCodec);
const SEEN = accountPreference('hasOnboarded', flagCodec('true'));

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('keys', () => {
  test('browser keys keep the names they always had, so existing settings survive', () => {
    expect(storageKey(UNITS)).toBe('fueltracker.units');
  });

  test('account keys carry the uid, after the name', () => {
    expect(storageKey(LAST, 'abc')).toBe('fueltracker.lastSyncedAt.u.abc');
    expect(storageKey(LAST, 'abc')).not.toBe(storageKey(LAST, 'abd'));
  });

  test('no account means no key at all', () => {
    expect(storageKey(LAST, null)).toBeNull();
    expect(storageKey(LAST, '')).toBeNull();
    expect(storageKey(LAST, 'x'.repeat(MAX_UID_LENGTH + 1))).toBeNull();
    expect(storageKey(LAST, 'x'.repeat(MAX_UID_LENGTH))).not.toBeNull();
  });
});

describe('two accounts on one browser', () => {
  test('each reads only what it wrote', () => {
    expect(writePreference(LAST, 111, 'a')).toBe(true);
    expect(writePreference(LAST, 222, 'b')).toBe(true);
    expect(readPreference(LAST, 'a')).toBe(111);
    expect(readPreference(LAST, 'b')).toBe(222);
    expect(readPreference(LAST, 'c')).toBeNull();
  });

  test('removing one leaves the other', () => {
    writePreference(SEEN, true, 'a');
    writePreference(SEEN, true, 'b');
    removePreference(SEEN, 'a');
    expect(readPreference(SEEN, 'a')).toBeNull();
    expect(readPreference(SEEN, 'b')).toBe(true);
  });

  test('odd uids stay separate and never reach a prototype', () => {
    for (const uid of ['__proto__', 'constructor', 'a.b', 'a.u.b', 'ünïcødé', ' ', '../x']) {
      writePreference(LAST, uid.length, uid);
    }
    expect(readPreference(LAST, '__proto__')).toBe(9);
    expect(readPreference(LAST, 'a.u.b')).toBe(5);
    expect(readPreference(LAST, 'a')).toBeNull();
    expect(Object.prototype).not.toHaveProperty('lastSyncedAt');
  });

  test('without an account nothing is read or written', () => {
    expect(writePreference(LAST, 1, null)).toBe(false);
    expect(writePreference(LAST, 1, '')).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(readPreference(LAST, null)).toBeNull();
  });
});

describe('values from before accounts were scoped', () => {
  test('are never adopted, and are removed when the account preference is read', () => {
    localStorage.setItem('fueltracker.lastSyncedAt', '123');
    expect(readPreference(LAST, 'a')).toBeNull();
    expect(localStorage.getItem('fueltracker.lastSyncedAt')).toBeNull();
  });

  test('are removed on write too', () => {
    localStorage.setItem('fueltracker.hasOnboarded', 'true');
    writePreference(SEEN, true, 'a');
    expect(localStorage.getItem('fueltracker.hasOnboarded')).toBeNull();
  });

  test('a browser preference with the same shape of key is left alone', () => {
    localStorage.setItem('fueltracker.units', '{"x":1}');
    expect(readPreference(UNITS)).toEqual({ x: 1 });
    expect(localStorage.getItem('fueltracker.units')).toBe('{"x":1}');
  });
});

describe('garbage and hostile values', () => {
  test('JSON that is not JSON, or the wrong shape, reads as absent', () => {
    for (const raw of ['', 'not json', '{', 'null', '[]', '{"x":"1"}', '"x"', '1e999']) {
      localStorage.setItem('fueltracker.units', raw);
      expect(readPreference(UNITS), raw).toBeNull();
    }
  });

  test('numbers must be finite', () => {
    for (const raw of ['', 'NaN', 'Infinity', '-Infinity', '1e999', 'abc', ' ']) {
      localStorage.setItem(storageKey(LAST, 'a')!, raw);
      expect(readPreference(LAST, 'a'), JSON.stringify(raw)).toBeNull();
    }
    localStorage.setItem(storageKey(LAST, 'a')!, '1700000000000');
    expect(readPreference(LAST, 'a')).toBe(1_700_000_000_000);
  });

  test('a flag is set only by its exact value', () => {
    for (const raw of ['TRUE', 'yes', '1', 'true ', '']) {
      localStorage.setItem(storageKey(SEEN, 'a')!, raw);
      expect(readPreference(SEEN, 'a'), raw).toBeNull();
    }
  });

  test('a decoder that throws reads as absent rather than taking the app down', () => {
    const fragile = browserPreference('fragile', {
      decode: () => {
        throw new Error('boom');
      },
      encode: String,
    });
    localStorage.setItem('fueltracker.fragile', 'x');
    expect(readPreference(fragile)).toBeNull();
  });

  test('an oversized value reads normally; size is the browser quota’s business', () => {
    localStorage.setItem('fueltracker.units', JSON.stringify({ x: 1, pad: 'p'.repeat(1_000_000) }));
    expect(readPreference(UNITS)).toMatchObject({ x: 1 });
  });
});

describe('storage that refuses', () => {
  test('a read that throws reads as absent', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readPreference(UNITS)).toBeNull();
    expect(readPreference(LAST, 'a')).toBeNull();
  });

  test('a write that throws — full, or private mode — reports failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(writePreference(UNITS, { x: 1 })).toBe(false);
    expect(writePreference(LAST, 1, 'a')).toBe(false);
  });

  test('a remove that throws is swallowed', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => removePreference(UNITS)).not.toThrow();
    expect(() => readPreference(LAST, 'a')).not.toThrow();
  });

  test('storage that cannot even be reached is the same as storage that refuses', () => {
    // Some browsers throw on *accessing* window.localStorage with cookies off.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readPreference(UNITS)).toBeNull();
    expect(writePreference(LAST, 1, 'a')).toBe(false);
    expect(() => removePreference(SEEN, 'a')).not.toThrow();
  });
});

describe('useAccountPreference', () => {
  test('reads the signed-in account, and falls back when there is nothing', () => {
    writePreference(LAST, 5, 'a');
    const { result } = renderHook(() => useAccountPreference(LAST, 'a', null));
    expect(result.current[0]).toBe(5);
    const other = renderHook(() => useAccountPreference(LAST, 'b', null));
    expect(other.result.current[0]).toBeNull();
  });

  test('setting it stores it for that account only', () => {
    const { result } = renderHook(() => useAccountPreference(LAST, 'a', null));
    act(() => result.current[1](42));
    expect(result.current[0]).toBe(42);
    expect(readPreference(LAST, 'a')).toBe(42);
    expect(readPreference(LAST, 'b')).toBeNull();
  });

  test('follows the account when it changes within one mount', () => {
    writePreference(LAST, 1, 'a');
    writePreference(LAST, 2, 'b');
    const view = renderHook(({ uid }) => useAccountPreference(LAST, uid, null), {
      initialProps: { uid: 'a' as string | null },
    });
    expect(view.result.current[0]).toBe(1);
    view.rerender({ uid: 'b' });
    expect(view.result.current[0]).toBe(2);
    // And a write after the switch lands on the new account, not the old one.
    act(() => view.result.current[1](3));
    expect(readPreference(LAST, 'a')).toBe(1);
    expect(readPreference(LAST, 'b')).toBe(3);
    view.rerender({ uid: null });
    expect(view.result.current[0]).toBeNull();
  });

  test('signed out, the value is the fallback and setting it stores nothing', () => {
    const { result } = renderHook(() => useAccountPreference(SEEN, null, false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(localStorage.length).toBe(0);
  });
});
