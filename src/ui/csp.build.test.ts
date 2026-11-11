import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_PROJECT_ID } from '../data/firebase/settings';

/**
 * The Content-Security-Policy, and the one property of the build that makes a
 * strict one possible.
 *
 * Reads `dist/` and `firebase.json`, so it is a `*.build.test.ts` file, like
 * `manifest.build.test.ts`: it runs through `npm run test:build`, which builds
 * first (#97). It used to fail with ENOENT on a fresh clone while the other
 * two skipped; now none of them runs without a build.
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

/**
 * The **enforced** policy, as a directive → value map.
 *
 * Deliberately not falling back to `Content-Security-Policy-Report-Only`. It
 * used to, which meant every assertion below passed just as happily against a
 * policy the browser was only reporting on — so the flip to enforcing would
 * have been invisible to CI, and a revert to report-only equally so. Reading
 * only the enforcing header makes this whole file fail if the policy stops
 * being enforced.
 */
function policy(): Map<string, string> {
  const raw = headers().get('Content-Security-Policy');
  expect(
    raw,
    'the CSP must be served as Content-Security-Policy, not Report-Only: report-only blocks nothing',
  ).toBeDefined();
  return parsePolicy(raw ?? '');
}

/** A directive's value as its separate sources. */
function sources(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter((token) => token !== '');
}

/** A policy's text as a directive → value map. */
function parsePolicy(raw: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of raw.split(';')) {
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
      "an inline <script> would be blocked by script-src 'self' in production only",
    ).toEqual([]);
  });

  it('has no inline style block', () => {
    const inline = [...html().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].filter(
      ([, body]) => (body ?? '').trim() !== '',
    );
    expect(inline).toHaveLength(0);
  });

  it('has no inline style attribute, which a policy without unsafe-inline would refuse (#82)', () => {
    // React's `style` props are set through CSSOM, which CSP does not govern;
    // a `style="…"` in the page's HTML is parsed, and is.
    expect(html()).not.toMatch(/<[^>]+\sstyle=/);
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
  it('is enforced rather than reported', () => {
    // #28. The policy was served report-only for its whole life: the browser
    // evaluated it, logged what it would have refused, and refused nothing.
    // A policy that blocks nothing is documentation, and its value arrives the
    // moment something else has already gone wrong — which is precisely when
    // nobody is reading a console.
    const all = headers();
    expect(all.has('Content-Security-Policy')).toBe(true);
    // A report-only header *alongside* the enforced one is legitimate — it is
    // how a stricter candidate gets trialled — but it must never be the only
    // one. Hence the assertion above rather than a ban on this one.
  });

  it('allows the script Firebase Auth injects, and nothing else off-origin', () => {
    // Found by running the live check from docs/csp-check.md rather than by
    // reasoning: signing in was refused twice under `script-src 'self'`.
    // Firebase Auth injects `https://apis.google.com/js/api.js` to host its
    // auth iframe, and that file then loads a second gapi chunk from a
    // generated path on the same origin — so the origin is allowed, not a
    // path. Enforcing the policy without this would have broken sign-in for
    // every account on the next deploy.
    //
    // It does mean Google can serve arbitrary script to this page, which is
    // already true of anyone using Firebase Auth's popup flow: there is no
    // supported way to run it without that script.
    const scriptSrc = policy().get('script-src') ?? '';
    expect(scriptSrc).toContain('https://apis.google.com');
    const offOrigin = scriptSrc.split(/\s+/).filter((source) => source.startsWith('http') || source.includes('*'));
    expect(offOrigin, 'script-src should name exactly one off-origin source').toEqual(['https://apis.google.com']);
  });

  it('does not weaken script-src', () => {
    // Asserted directly, so loosening it later has to be a visible, deliberate
    // edit to this file rather than a quiet addition to a long header string.
    // Compared as tokens, not substrings: `'wasm-unsafe-eval'` (below) contains
    // the text `unsafe-eval`, and a substring check would either forbid the one
    // or quietly permit the other.
    const tokens = (policy().get('script-src') ?? '').split(/\s+/);
    expect(tokens).toContain("'self'");
    expect(tokens).not.toContain("'unsafe-inline'");
    expect(tokens).not.toContain("'unsafe-eval'");
  });

  it('lets WebAssembly compile, and nothing else that eval would', () => {
    // #17. The receipt reader is WebAssembly, and since #39 enforced this
    // policy, compiling it needs `'wasm-unsafe-eval'` — without it a scan
    // fails inside its worker, where the page's violation watcher cannot see
    // it. The token permits `WebAssembly.compile` and nothing else: no `eval`,
    // no `new Function`.
    const tokens = (policy().get('script-src') ?? '').split(/\s+/);
    expect(tokens).toContain("'wasm-unsafe-eval'");
  });

  /**
   * Exact hosts, no wildcards (#82). The policy used to allow any
   * `*.googleapis.com` — Cloud Storage among them, where anybody can host a
   * bucket, so an exfiltration channel if an injection ever appeared — and any
   * `*.firebaseapp.com`. These are the hosts the bundled Firebase SDK actually
   * contacts, and a run of csp-check.md on the live site refused nothing
   * under them before they were enforced.
   */
  it('names no wildcard host anywhere', () => {
    for (const [directive, value] of policy()) {
      expect(value, directive).not.toMatch(/\*/);
    }
  });

  it('connects only to Firestore, the identity toolkit and token refresh', () => {
    expect(sources(policy().get('connect-src')).sort()).toEqual(
      [
        "'self'",
        'https://firestore.googleapis.com',
        'https://identitytoolkit.googleapis.com',
        'https://securetoken.googleapis.com',
      ].sort(),
    );
  });

  it('frames only this project’s auth domain and Google’s account chooser', () => {
    // The sign-in popup's auth iframe is served from the auth domain.
    expect(sources(policy().get('frame-src')).sort()).toEqual(
      [`https://${PRODUCTION_PROJECT_ID}.firebaseapp.com`, 'https://accounts.google.com'].sort(),
    );
  });

  it('allows no inline style', () => {
    // React's `style` props go through CSSOM, which CSP does not govern; the
    // built page has no `style=` attribute (checked above).
    expect(sources(policy().get('style-src'))).toEqual(["'self'"]);
  });

  it('names no CDN: the receipt reader is served from this origin', () => {
    // #17. tesseract.js used to fetch its worker, wasm core and language data
    // from jsDelivr at scan time — third-party code, fetched at runtime and
    // run with this origin's access to the fuel log. It is self-hosted now,
    // so the CDN has no business in any directive.
    for (const [directive, sources] of policy()) {
      expect(sources, directive).not.toContain('jsdelivr');
    }
  });

  it('runs workers from this origin only, and still shows receipt previews', () => {
    // The reader's worker is a real same-origin script now (`workerBlobURL:
    // false`), so `blob:` workers — code with no URL anybody can audit — are
    // no longer needed. Blob *images* still are: that is the receipt preview.
    expect(policy().get('worker-src')).toBe("'self'");
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
