/**
 * The cars this device holds because they were shared with it (#66).
 *
 * Apart from the sync cursor (`syncState.ts`) since #91: the two are kept in
 * the same database, but one says where a sync left off and the other which
 * shared cars this device must keep out of its own account (#77).
 */

import { isStorableId } from './recordId';
import { TEXT_LIMITS, boundText } from '../domain/textLimits';
import type { Membership } from './sharingTypes';

/** The shared cars this device holds rows for. See `DexieShareLedger`. */
export interface ShareLedger {
  load(): Promise<Membership[]>;
  save(list: readonly Membership[]): Promise<void>;
}

/** A stored ledger, keeping only well-formed entries. Junk reads as none. */
export function parseLedger(value: unknown): Membership[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const raw = entry as Record<string, unknown>;
    // Both become document paths and scope keys, and the account's copy is
    // read from the network (#86): an id that could not name a document is
    // not a share, whatever else the entry says.
    if (!isStorableId(raw.ownerUid) || !isStorableId(raw.vehicleId)) return [];
    return [
      {
        ownerUid: raw.ownerUid,
        vehicleId: raw.vehicleId,
        ownerName: typeof raw.ownerName === 'string' ? boundText(raw.ownerName, TEXT_LIMITS.ownerName) : '',
        vehicleName: typeof raw.vehicleName === 'string' ? boundText(raw.vehicleName, TEXT_LIMITS.vehicleName) : '',
      },
    ];
  });
}
