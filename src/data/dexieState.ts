/**
 * What a sync keeps between runs, in the account's database (#91: apart from
 * the schema in `db.ts`): the sync cursor, and the share ledger.
 */

import type { FuelTrackerDatabase } from './db';
import type { SyncCursor, SyncStateStore } from './syncState';
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
    await this.db.syncState.delete(this.key);
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
