import { describe, expect, test } from 'vitest';
import type { LinkProblem } from '../data/fillUpLink';
import { linkProblemText } from './linkMessages';

/**
 * What a broken link says (#93: moved out of `SubmitScreen.tsx`, where
 * `IncomingScreen` had to import it from another screen). Words about a
 * data-layer problem live in `ui/`, like `syncMessages.ts` (#91).
 */

/** Every problem, listed so that adding one to `LinkProblem` fails to compile here until it is. */
const EVERY: Record<LinkProblem, true> = {
  'too-long': true,
  damaged: true,
  'wrong-kind': true,
  'newer-version': true,
  invalid: true,
};
const PROBLEMS = Object.keys(EVERY) as LinkProblem[];
const KINDS = ['request', 'submission'] as const;

describe('a broken link says what to do', () => {
  test.each(PROBLEMS.flatMap((problem) => KINDS.map((kind) => [problem, kind] as const)))(
    '%s, for a %s',
    (problem, kind) => {
      const text = linkProblemText(problem, kind);
      expect(text.trim().length).toBeGreaterThan(20);
      expect(text).not.toMatch(/undefined|null|\[object/);
    },
  );

  test('each problem is said differently, so a reader can tell them apart', () => {
    for (const kind of KINDS) {
      const said = PROBLEMS.map((problem) => linkProblemText(problem, kind));
      expect(new Set(said).size).toBe(PROBLEMS.length);
    }
  });

  test('a request and a submission are told apart where it matters', () => {
    expect(linkProblemText('wrong-kind', 'request')).toMatch(/request/);
    expect(linkProblemText('wrong-kind', 'submission')).not.toMatch(/request/);
    expect(linkProblemText('invalid', 'request')).toMatch(/car/);
    expect(linkProblemText('invalid', 'submission')).toMatch(/does not add up/);
  });

  test('what can be fixed by asking again says so; what needs an update says to reload', () => {
    for (const problem of ['too-long', 'damaged', 'invalid'] as const) {
      for (const kind of KINDS) expect(linkProblemText(problem, kind)).toMatch(/sent again/);
    }
    expect(linkProblemText('newer-version', 'submission')).toMatch(/Reload/);
  });
});
