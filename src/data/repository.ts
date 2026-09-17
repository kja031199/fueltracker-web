/**
 * The whole persistence abstraction.
 *
 * Four methods, deliberately. No query builder, no sync engine, no conflict
 * resolution — those belong to a later phase and guessing at their shape now
 * would bake in assumptions before there is anything to check them against.
 *
 * Two implementations exist and both matter: `DexieRepository` is what the app
 * runs on, and `InMemoryRepository` below is what the tests run on and what a
 * demo session uses. Having the second one is not busywork — it is the proof
 * that this interface has not quietly grown a Dexie-shaped hole in it.
 */

import type { SyncFields } from './records';

export interface Repository<T extends SyncFields> {
  /** Every live record. Tombstoned rows are **excluded**. */
  list(): Promise<T[]>;
  /** One record by id, or `undefined`. A tombstoned row reads as absent. */
  get(id: string): Promise<T | undefined>;
  /** Insert or replace by id. */
  put(record: T): Promise<void>;
  /**
   * Soft-delete: stamps `deletedAt` rather than dropping the row, so the
   * deletion is itself a fact that can be synced. A record that is already
   * gone is a no-op, never an error.
   */
  remove(id: string): Promise<void>;
  /**
   * Tombstoned records, for a future sync push. Nothing reads this yet; it
   * exists because a tombstone nobody can enumerate is just a leak.
   */
  listDeleted(): Promise<T[]>;
}

/**
 * A `Repository` backed by a plain `Map`.
 *
 * Used by the test suite and by a demo session that should leave nothing
 * behind. Records are stored as handed over — they are readonly interfaces, so
 * the caller cannot mutate one afterwards and change what is "stored" — and
 * returned in insertion order, which keeps test expectations legible.
 */
export class InMemoryRepository<T extends SyncFields> implements Repository<T> {
  private readonly rows = new Map<string, T>();

  constructor(seed: readonly T[] = []) {
    for (const record of seed) this.rows.set(record.id, record);
  }

  async list(): Promise<T[]> {
    return [...this.rows.values()].filter((row) => row.deletedAt === null);
  }

  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row === undefined || row.deletedAt !== null ? undefined : row;
  }

  async put(record: T): Promise<void> {
    this.rows.set(record.id, record);
  }

  async remove(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (row === undefined || row.deletedAt !== null) return;
    this.rows.set(id, { ...row, deletedAt: Date.now(), updatedAt: Date.now() });
  }

  async listDeleted(): Promise<T[]> {
    return [...this.rows.values()].filter((row) => row.deletedAt !== null);
  }
}
