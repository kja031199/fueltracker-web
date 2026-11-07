/**
 * An edit that cannot be saved because what it edits is no longer there
 * (#83).
 *
 * The edit form can stay open while a sync changes the log underneath it: the
 * fill-up deleted on another device, or its car deleted or no longer shared.
 * Saving used to write anyway — under whichever car was *selected*, which after
 * such a sync is a different car, so the fill-up moved silently; or, for a
 * fill-up deleted meanwhile, as a new row that brought it back. Now the store
 * refuses, and the form says why.
 *
 * Its own module, not `store.ts`, so the form can recognise it: screens may
 * not import the store (`storeBoundary.test.ts`).
 */

export type StaleEditReason = 'fill-up-gone' | 'car-gone';

export class StaleEdit extends Error {
  constructor(readonly reason: StaleEditReason) {
    super(
      reason === 'fill-up-gone'
        ? 'This fill-up was deleted while you were editing it, so the changes were not saved.'
        : 'The car this fill-up belongs to is no longer in your log, so the changes were not saved.',
    );
  }
}
