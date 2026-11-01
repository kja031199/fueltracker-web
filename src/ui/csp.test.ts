import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Content-Security-Policy, and the one property of the build that makes a
 * strict one possible.
 *
 * Reads `dist/` and `firebase.json`, so it is in the same family as
 * `manifest.test.ts` — and the same reason the build runs **before** the tests
 * in CI, or these would silently skip.
 *
 * ## Why a test about HTML belongs with a test about headers
 *
 * `script-src 'self'` is only achievable because the built page carries no
 * inline script. Nothing enforces that today: Vite happens to emit a single
 * `<script src>`, and a future plugin or a hand edit to `index.html` could add
 * an inline one without any local symptom at all. It would break only in
 * production, only once the policy is enforced, and only for whoever loaded
 * the page. Catching it in CI is the difference between a failed check and a
 * white screen on someone's phone.
 */

const html = (): string => readFileSync('dist/index.html', 'utf8');

interface HeaderEntry {
  readonly source: string;
  readonly headers: readonly { readonly key: string; readonly value: string }[];
}

function headers(): Map<string, string> {
  const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as {
    hosting: { headers: readonly HeaderEntry[] };
  };
  const found = new Map<string, string>();
  for (const entry of config.hosting.headers) {
    if (entry.source !== '**') continue;
    for (const header of entry.headers) found.set(header.key, header.value);
  }
  return found;
}

/** The policy as a directive → value map, from whichever CSP header is set. */
function policy(): Map<string, string> {
  const all = headers();
  const raw = all.get('Content-Security-Policy') ?? all.get('Content-Security-Policy-Report-Only');
  expect(raw, 'no CSP header is configured at all').toBeDefined();
  const directives = new Map<string, string>();
  for (const part of (raw ?? '').split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const space = trimmed.indexOf(' ');
    if (space === -1) directives.set(trimmed, '');
    else directives.set(trimmed.slice(0, space), trimmed.slice(space + 1));
  }
  return directives;
}

describe('the built page stays compatible with a strict policy', () => {
  it('has no inline script', () => {
    const inline = [...html().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(
      ([, , body]) => (body ?? '').trim() !== '',
    );
    expect(
      inline.map(([, attrs]) => attrs),
      'an inline <script> would be blocked by script-src \'self\' in production only',
    ).toEqual([]);
  });

  it('has no inline style block', () => {
    const inline = [...html().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].filter(
      ([, body]) => (body ?? '').trim() !== '',
    );
    expect(inline).toHaveLength(0);
  });

  it('loads its script from this origin', () => {
    const sources = [...html().matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map(([, src]) => src ?? '');
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect(src.startsWith('/'), `${src} is not same-origin`).toBe(true);
    }
  });
});

describe('the policy', () => {
  it('does not weaken script-src', () => {
    // Asserted directly, so loosening it later has to be a visible, deliberate
    // edit to this file rather than a quiet addition to a long header string.
    const scriptSrc = policy().get('script-src') ?? '';
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('names every origin the app contacts at runtime', () => {
    const connect = policy().get('connect-src') ?? '';
    // Firestore, token refresh and the identity toolkit.
    expect(connect).toContain('googleapis.com');
    // The auth handler, which the sign-in popup completes against.
    expect(connect).toContain('firebaseapp.com');
    // tesseract.js fetches its worker, wasm core and language data from here
    // at scan time. Easy to miss, because nothing in this repository's source
    // mentions it — it is a default inside the library.
    expect(connect).toContain('cdn.jsdelivr.net');
  });

  it('allows the blob worker and blob images receipts rely on', () => {
    expect(policy().get('worker-src') ?? '').toContain('blob:');
    expect(policy().get('img-src') ?? '').toContain('blob:');
  });

  it('shuts the doors nothing here needs', () => {
    expect(policy().get('object-src')).toBe("'none'");
    expect(policy().get('frame-ancestors')).toBe("'none'");
    expect(policy().get('base-uri')).toBe("'self'");
  });
});

describe('the headers that can break sign-in', () => {
  it('does not isolate the opener', () => {
    // `same-origin` severs window.opener and breaks signInWithPopup. It is the
    // single most likely way a headers change takes this app down, and the
    // failure appears only on the deployed site.
    const coop = headers().get('Cross-Origin-Opener-Policy');
    expect(coop, 'same-origin would break signInWithPopup').not.toBe('same-origin');
    expect(coop).toBe('same-origin-allow-popups');
  });

  it('sets the headers that cannot break anything', () => {
    const all = headers();
    expect(all.get('X-Content-Type-Options')).toBe('nosniff');
    expect(all.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(all.get('X-Frame-Options')).toBe('DENY');
  });

  it('grants no device permissions, because the app uses none', () => {
    // Receipts arrive through a file input, and GPS station detection was
    // dropped in the port. If either changes, this test is the reminder that
    // the header has to change with it.
    const permissions = headers().get('Permissions-Policy') ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });
});
