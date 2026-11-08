/**
 * What sharing a car is made of (#66), as plain shapes.
 *
 * Apart from `sharing.ts` (#91) so that the storage modules — the device's
 * database, the share ledger — can name a membership without depending on the
 * sharing remote and the in-memory world that sit beside these in it.
 */

/** An open invitation to one car, addressed to one email. */
export interface Invite {
  readonly ownerUid: string;
  readonly vehicleId: string;
  /** Lowercased: the rules compare it to the token's address, lowercased. */
  readonly email: string;
  readonly ownerName: string;
  readonly vehicleName: string;
  readonly createdAt: number;
}

/** Somebody a car is shared with. */
export interface Member {
  readonly uid: string;
  readonly name: string;
  readonly email: string;
  readonly joinedAt: number;
}

/** A car shared *with* this account. */
export interface Membership {
  readonly ownerUid: string;
  readonly vehicleId: string;
  readonly ownerName: string;
  readonly vehicleName: string;
}

/** The signed-in account, as sharing needs it. */
export interface Account {
  readonly uid: string;
  readonly name: string;
  /** As Google reports it; compared lowercased. */
  readonly email: string;
  readonly emailVerified: boolean;
}
