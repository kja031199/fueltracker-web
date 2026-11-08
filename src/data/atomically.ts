/**
 * One place that says how a group of writes is made all-or-nothing (#85).
 *
 * The store's merges and cascades used to read, decide and write a row at a
 * time, with an `await` between each: a save that landed in between was
 * overwritten by a decision made before it, and a delete interrupted part way
 * was left part done. Each now runs here, and decides against rows it reads
 * here.
 */

import type { Repositories } from './repository';

/**
 * Runs `work` in the repositories' transaction — every write in it lands or
 * none does, and no other write lands in the middle — or, where they have
 * none (the in-memory ones of the tests and the demo), simply runs it.
 *
 * **`work` must read and write through the repositories it is handed**, not
 * ones it captured. Those are bound to the transaction; others are not, and a
 * write through them is a write of its own, outside it.
 */
export function atomically<R>(repos: Repositories, work: (repos: Repositories) => Promise<R>): Promise<R> {
  return repos.transaction === undefined ? work(repos) : repos.transaction(work);
}
