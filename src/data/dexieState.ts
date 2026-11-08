/**
 * What a sync keeps between runs, in the account's database (#91: apart from
 * the schema in `db.ts`): the sync cursor, and the share ledger.
 */

import type { FuelTrackerDatabase } from './db';
import type { Table } from 'dexie';
import type { KnownUpdate, SyncCursor, SyncStateStore } from './syncState';
import { parseCursor } from './syncState';
import { parseLedger, type ShareLedger } from './shareLedger';
import type { Membership } from './sharingTypes';

/**
 * The sync cursor, in the same database as the rows it describes (#52), so
 * the two can only ever be cleared together. See `syncState.ts`.
 */
export class DexieSyncState implements SyncStateStore {
  /**
   * `key` names whose cursor this is: `'cursor'` for the account's own tree,
   * and one key per car shared with it (#66), since each is read separately.
   */
  constructor(
    private readonly db: FuelTrackerDatabase,
    private readonly key: string = 'cursor',
  ) {}

  async load(): Promise<SyncCursor | null> {
    const row = await this.db.syncState.get(this.key);
    return parseCursor(row?.['cursor']);
  }

  async save(cursor: SyncCursor): Promise<void> {
    await this.db.syncState.put({ key: this.key, cursor });
  }

  async clear(): Promise<void> {
    await this.db.transaction('rw', this.db.syncState, this.db.knownVersions, async (tx) => {
      await tx.table('syncState').delete(this.key);
      await this.known(tx.table('knownVersions') as Table<{ key: string; at: number }, string>).delete();
    });
  }

  /**
   * This cursor's own known versions: its key, then a NUL. Not `|` or any
   * printable character: a shared car's id is in the key, an id may hold
   * those, and `share:u__X|` would then be the start of `share:u__X|Y`'s
   * versions too. An id that can be stored never holds a control character.
   */
  private get prefix(): string {
    return `${this.key}\u0000`;
  }

  private known(table: Table<{ key: string; at: number }, string>, collection = '') {
    return table.where('key').startsWith(`${this.prefix}${collection}`);
  }

  async loadKnown(): Promise<Record<string, number>> {
    const rows = await this.known(this.db.knownVersions).toArray();
    const known: Record<string, number> = {};
    for (const row of rows) if (Number.isFinite(row.at)) known[row.key.slice(this.prefix.length)] = row.at;
    return known;
  }

  /** Clears the collections read in full and writes the versions read, together. */
  async saveKnown(update: KnownUpdate): Promise<void> {
    await this.db.transaction('rw', this.db.knownVersions, async (tx) => {
      const table = tx.table('knownVersions') as Table<{ key: string; at: number }, string>;
      for (const collection of update.replace) await this.known(table, `${collection}/`).delete();
      await table.bulkPut(Object.entries(update.set).map(([key, at]) => ({ key: `${this.prefix}${key}`, at })));
    });
  }
}

/**
 * The cars this device holds because they were shared with it (#66), kept so
 * that one which stops being shared — left on another device, or removed by
 * its owner — is recognised as such and forgotten here too.
 */
export class DexieShareLedger implements ShareLedger {
  constructor(private readonly db: FuelTrackerDatabase) {}

  async load(): Promise<Membership[]> {
    const row = await this.db.syncState.get('shares');
    return parseLedger(row?.['shares']);
  }

  async save(list: readonly Membership[]): Promise<void> {
    await this.db.syncState.put({ key: 'shares', shares: [...list] });
  }
}
