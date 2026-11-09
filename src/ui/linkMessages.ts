/**
 * What a broken fill-up link (#3) says, in words its reader can act on.
 *
 * Moved out of `SubmitScreen.tsx` (#93), where `IncomingScreen` had to import
 * it from another screen. The problem is a data-layer code (`LinkProblem`);
 * the sentence is the interface's, like `syncMessages.ts` (#91).
 */

import type { LinkProblem } from '../data/fillUpLink';

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
