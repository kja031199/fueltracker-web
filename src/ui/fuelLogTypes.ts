/**
 * The fuel log's shape, as the screens see it (#56): what \`useFuelLog()\`,
 * \`useSyncStatus()\` and \`useBackupStatus()\` hand them. Its own file (#93) so
 * the provider in \`fuelLog.tsx\` is the provider and nothing else.
 */

import type { FillUpRecord, Snapshot, VehicleRecord } from '../data/records';
import type { ImportSummary } from '../data/backup';
import type { NewVehicle } from '../data/store';
import type { Invite, Member, Membership } from '../data/sharing';
import type { FuelEntryDraft } from '../domain/fuelEntryDraft';
import type { Submission } from '../data/fillUpLink';
import type { BackupPromptReason } from '../domain/exportReminder';
import type { AppData } from './useAppData';
import type { BackupSummary } from './exportBackup';

/**
 * Sharing a car (#66), as the screens see it. `enabled` is false without an
 * account to share through (no backend, or signed out), and then every list is
 * empty and every action refuses.
 */
export interface SharingView {
  readonly enabled: boolean;
  /** Cars shared *with* this account. */
  readonly sharedWithMe: readonly Membership[];
  /** Invitations waiting for this account's verified email. */
  readonly invitesForMe: readonly Invite[];
  /** The membership a car is held by, or undefined when it is this account's own. */
  membershipFor(vehicleId: string): Membership | undefined;
  /** Invites `email` to one of this account's cars. */
  invite(vehicle: Pick<VehicleRecord, 'id' | 'name'>, email: string): Promise<void>;
  withdrawInvite(vehicleId: string, email: string): Promise<void>;
  /** Unanswered invitations this account sent for one car. */
  invitesSentFor(vehicleId: string): Promise<Invite[]>;
  /** Who a car is shared with — this account's own car, or one shared with it. Read fresh. */
  membersOf(vehicleId: string): Promise<Member[]>;
  /**
   * The names to show for who entered a car's fill-ups — `null` for a car
   * nobody shares, where "entered by you" on every row would be noise.
   * `entered` is the uids its fill-ups carry. Remembered per car (#89): read
   * once, and again only when a fill-up names somebody it has not seen.
   */
  namesFor(vehicleId: string, entered: readonly (string | null | undefined)[]): Promise<ReadonlyMap<string, string> | null>;
  removeMember(vehicleId: string, memberUid: string): Promise<void>;
  /** Joins, then syncs so the car arrives at once. */
  accept(invite: Invite): Promise<void>;
  decline(invite: Invite): Promise<void>;
  /** Leaves, then syncs, which forgets the car on this device. */
  leave(membership: Membership): Promise<void>;
}


/**
 * The fuel log. Sync status is **not** in here (#88): it changes several
 * times per sync, and every screen reads this — `useSyncStatus()` is its own
 * context, read by the few screens that show it.
 */
export interface FuelLog extends Omit<AppData, 'reload'> {
  readonly sharing: SharingView;
  /** The signed-in account's uid, for "entered by you". Null when there is none. */
  readonly me: string | null;

  // Writes: each refreshes what is shown and schedules a sync.
  addVehicle(vehicle: NewVehicle): Promise<VehicleRecord>;
  removeVehicle(id: string): Promise<void>;
  addFillUp(draft: FuelEntryDraft, vehicleId: string): Promise<FillUpRecord>;
  /**
   * Edits a fill-up on the car it is already on (#83). Rejects with
   * `StaleEdit` when it, or its car, has gone since the form opened — and then
   * refreshes, since what the screen shows is out of date.
   */
  updateFillUp(id: string, draft: FuelEntryDraft): Promise<FillUpRecord>;
  removeFillUp(id: string): Promise<void>;
  importBackup(snapshot: Snapshot): Promise<ImportSummary>;
  /**
   * Queues a fill-up that arrived by link (#3) for review. Refused as
   * `'not-yours'` for a car shared *with* this account: requests are made
   * from a car's owner, so a submission for somebody else's car was not sent
   * here to be received.
   */
  receiveSubmission(submission: Submission): Promise<ReceiveResult>;
  /** The fill-up it became, or null when it could not be (its car is gone, it no longer validates). */
  approveSubmission(id: string): Promise<FillUpRecord | null>;
  rejectSubmission(id: string): Promise<void>;

  // Reads.
  /**
   * One fill-up whole, photo included, for editing. The list holds summaries
   * without photo bytes (#53). `undefined` when it has gone since the list was
   * drawn — deleted on another device and synced — in which case the list is
   * refreshed, but nothing is synced, because nothing here changed.
   */
  loadFillUp(id: string): Promise<FillUpRecord | undefined>;
  /**
   * Downloads a JSON backup, says what it held, and **records it for the
   * reminder** — whichever screen asked (#93). The no-access screen used to
   * download one and record nothing.
   */
  saveBackup(): Promise<BackupSummary>;
  /** Downloads the live fill-ups as CSV and says how many. Not a backup, so not recorded. */
  exportCsv(): Promise<number>;
  /**
   * Reads a file somebody chose — `.csv` or a JSON backup — and imports it.
   * A file that cannot be read imports nothing and says why.
   */
  importFile(file: File): Promise<FileImport>;
}

/** What importing a file did: the store's summary, or null when the file could not be read; and every row or reason to show. */
export interface FileImport {
  readonly summary: ImportSummary | null;
  readonly problems: readonly string[];
}

/**
 * The backup reminder, as the screens see it (#93). Its own context, like sync
 * status: the banner and Settings read it, and recording a backup re-renders
 * them, not every screen.
 */
export interface BackupStatus {
  /** Why a backup is being suggested, or null when it is not. */
  readonly reason: BackupPromptReason | null;
  readonly lastBackupAt: number | null;
  /** Dismiss for a week. Deliberately not forever. */
  readonly snooze: () => void;
}

export type ReceiveResult = 'queued' | 'duplicate' | 'no-such-car' | 'not-yours';
