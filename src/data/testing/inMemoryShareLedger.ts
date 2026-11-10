/** A share ledger held in memory, for tests (#96: moved out of `shareLedger.ts`). */

import type { ShareLedger } from '../shareLedger';
import type { Membership } from '../sharingTypes';

export class InMemoryShareLedger implements ShareLedger {
  private list: Membership[] = [];

  async load(): Promise<Membership[]> {
    return [...this.list];
  }

  async save(list: readonly Membership[]): Promise<void> {
    this.list = [...list];
  }
}
