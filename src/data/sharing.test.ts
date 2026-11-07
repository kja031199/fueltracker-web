import { describe, expect, test } from 'vitest';
import {
  InMemorySharingWorld,
  MAX_EMAIL_LENGTH,
  Refused,
  inviteKey,
  membershipKey,
  normalizeEmail,
  scopeSnapshot,
  type Account,
} from './sharing';
import { isRefusal } from './sync';
import { parseLedger } from './syncState';
import type { FillUpRecord, VehicleRecord } from './records';
import { SCHEMA_VERSION } from './records';

/**
 * The sharing vocabulary and the in-memory world (#66), directly. The world is
 * what every non-emulator sharing test runs against, so it has to refuse what
 * `firestore.rules` refuses — or those tests prove nothing.
 */

const OWNER: Account = { uid: 'owner', name: 'Kyle', email: 'kyle@example.com', emailVerified: true };
const PARTNER: Account = { uid: 'partner', name: 'Sam', email: 'sam@example.com', emailVerified: true };
const THIRD: Account = { uid: 'third', name: 'Alex', email: 'alex@example.com', emailVerified: true };

const sync = { updatedAt: 1, deletedAt: null, schemaVersion: SCHEMA_VERSION };

function vehicle(id: string, deletedAt: number | null = null): VehicleRecord {
  return { id, ...sync, deletedAt, name: id, make: '', model: '', year: 2020, createdAt: 1 };
}

function fillUp(id: string, vehicleId: string, enteredBy: string | null): FillUpRecord {
  return {
    id, ...sync, vehicleId, date: 1_700_000_000_000, odometer: 10_000, gallons: 10, pricePerGallon: 3,
    isFullTank: true, missedPreviousFillUp: false, fuelGrade: 'Regular', station: '', notes: '',
    latitude: null, longitude: null, receiptImageData: null, enteredBy,
  };
}

/** A world with the owner's car `civic` (with one fill-up) and a private `truck`. */
async function world(): Promise<InMemorySharingWorld> {
  const w = new InMemorySharingWorld();
  await w.remoteFor(OWNER.uid).push({
    vehicles: [vehicle('civic'), vehicle('truck'), vehicle('gone', 5)],
    fillUps: [fillUp('f1', 'civic', OWNER.uid), fillUp('t1', 'truck', OWNER.uid)],
    pendingFillUps: [],
  });
  return w;
}

async function joined(): Promise<InMemorySharingWorld> {
  const w = await world();
  const invite = await w.sharingFor(OWNER).invite(vehicle('civic'), PARTNER.email);
  await w.sharingFor(PARTNER).accept(invite);
  return w;
}

describe('normalizeEmail', () => {
  test.each([
    ['sam@example.com', 'sam@example.com'],
    ['  Sam@Example.COM  ', 'sam@example.com'],
    ['sam+fuel@example.com', 'sam+fuel@example.com'],
    ['first.last@mail.example.co.uk', 'first.last@mail.example.co.uk'],
    ['a@b', 'a@b'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['no @', 'sam.example.com'],
    ['two @', 'sam@@example.com'],
    ['two @ apart', 'sam@x@example.com'],
    ['nothing before @', '@example.com'],
    ['nothing after @', 'sam@'],
    ['a space inside', 'sam smith@example.com'],
    ['a tab inside', 'sam\t@example.com'],
    ['a slash, which a document id cannot hold', 'sam/x@example.com'],
    ['too short', 'a@'],
  ])('refuses %s', (_label, raw) => {
    expect(normalizeEmail(raw)).toBeNull();
  });

  test('the longest address the rules accept is accepted, and one longer is not', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length);
    expect(normalizeEmail(`${local}@example.com`)).toHaveLength(MAX_EMAIL_LENGTH);
    expect(normalizeEmail(`a${local}@example.com`)).toBeNull();
  });
});

describe('document keys', () => {
  test('are deterministic, and the rules build the same strings', () => {
    expect(inviteKey('o', 'v', 'e@x.com')).toBe('o__v__e@x.com');
    expect(membershipKey({ ownerUid: 'o', vehicleId: 'v' })).toBe('o__v');
  });

  test('differ for different owners, cars and addresses', () => {
    const keys = [
      inviteKey('o1', 'v', 'e@x.com'),
      inviteKey('o2', 'v', 'e@x.com'),
      inviteKey('o1', 'w', 'e@x.com'),
      inviteKey('o1', 'v', 'f@x.com'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('Refused', () => {
  test('reads as a refusal to sync, exactly as Firestore’s does', () => {
    const refused = new Refused('anything');
    expect(refused.code).toBe('permission-denied');
    expect(isRefusal(refused)).toBe(true);
    expect(refused).toBeInstanceOf(Error);
  });
});

describe('scopeSnapshot', () => {
  const raw = {
    vehicles: [vehicle('civic'), vehicle('truck'), null, 'junk', { name: 'no id' }],
    fillUps: [fillUp('f1', 'civic', null), fillUp('t1', 'truck', null), null, 42, { id: 'x' }],
    pendingFillUps: [{ id: 'p1', vehicleId: 'civic' }],
    highWater: { vehicles: 7, fillUps: 9, pendingFillUps: 3 },
  };

  test('keeps the car and its fill-ups, and nothing else', () => {
    const scoped = scopeSnapshot(raw, 'civic');
    expect((scoped.vehicles as VehicleRecord[]).map((v) => v.id)).toEqual(['civic']);
    expect((scoped.fillUps as FillUpRecord[]).map((f) => f.id)).toEqual(['f1']);
  });

  test('never carries submissions — they are the owner’s alone', () => {
    expect(scopeSnapshot(raw, 'civic').pendingFillUps).toEqual([]);
    expect(scopeSnapshot(raw, 'civic').highWater?.pendingFillUps).toBeNull();
  });

  test('keeps the account-wide marks for the collections it reads', () => {
    expect(scopeSnapshot(raw, 'civic').highWater).toEqual({ vehicles: 7, fillUps: 9, pendingFillUps: null });
  });

  test('a pull with no marks stays without them', () => {
    const { highWater: _marks, ...unmarked } = raw;
    expect(scopeSnapshot(unmarked, 'civic').highWater).toBeUndefined();
  });

  test('an unknown car scopes to nothing', () => {
    const scoped = scopeSnapshot(raw, 'nope');
    expect(scoped.vehicles).toEqual([]);
    expect(scoped.fillUps).toEqual([]);
  });
});

describe('parseLedger', () => {
  test('keeps well-formed entries', () => {
    const entry = { ownerUid: 'o', vehicleId: 'v', ownerName: 'Kyle', vehicleName: 'Civic' };
    expect(parseLedger([entry])).toEqual([entry]);
  });

  test.each([
    ['not a list', { ownerUid: 'o' }],
    ['null', null],
    ['text', 'shares'],
    ['a number', 7],
  ])('reads %s as no shares', (_label, value) => {
    expect(parseLedger(value)).toEqual([]);
  });

  test('drops entries without an owner or a car, and keeps the rest', () => {
    const good = { ownerUid: 'o', vehicleId: 'v', ownerName: 'K', vehicleName: 'C' };
    expect(
      parseLedger([null, 'x', {}, { ownerUid: 'o' }, { vehicleId: 'v' }, { ownerUid: '', vehicleId: 'v' }, good]),
    ).toEqual([good]);
  });

  test('a missing or garbled name becomes empty, never a reason to drop the share', () => {
    expect(parseLedger([{ ownerUid: 'o', vehicleId: 'v', ownerName: 42, extra: 'x' }])).toEqual([
      { ownerUid: 'o', vehicleId: 'v', ownerName: '', vehicleName: '' },
    ]);
  });

  test('bounds the names it reads (#86)', () => {
    const [entry] = parseLedger([{ ownerUid: 'o', vehicleId: 'v', ownerName: 'K'.repeat(900), vehicleName: 'C'.repeat(900) }]);
    expect(entry?.ownerName).toHaveLength(200);
    expect(entry?.vehicleName).toHaveLength(200);
  });

  test('drops an entry whose ids could not name a document (#86)', () => {
    const good = { ownerUid: 'o', vehicleId: 'v', ownerName: 'Ann', vehicleName: 'Civic' };
    expect(
      parseLedger([
        { ...good, vehicleId: '../x' },
        { ...good, vehicleId: '..' },
        { ...good, vehicleId: '__reserved__' },
        { ...good, ownerUid: 'a/b' },
        { ...good, vehicleId: 'x'.repeat(2_000) },
        good,
      ]),
    ).toEqual([good]);
  });
});

describe('the in-memory world refuses what the rules refuse', () => {
  describe('invitations', () => {
    test('a valid one is stored, normalised', async () => {
      const w = await world();
      const invite = await w.sharingFor(OWNER).invite(vehicle('civic'), '  SAM@example.com ');
      expect(invite.email).toBe('sam@example.com');
      expect(invite.ownerName).toBe('Kyle');
      expect(await w.sharingFor(OWNER).invitesSent()).toHaveLength(1);
    });

    test('not to a car you do not have, or one you deleted', async () => {
      const w = await world();
      await expect(w.sharingFor(OWNER).invite(vehicle('nope'), PARTNER.email)).rejects.toBeInstanceOf(Refused);
      await expect(w.sharingFor(OWNER).invite(vehicle('gone'), PARTNER.email)).rejects.toBeInstanceOf(Refused);
      await expect(w.sharingFor(PARTNER).invite(vehicle('civic'), THIRD.email)).rejects.toBeInstanceOf(Refused);
    });

    test('not twice to the same address — withdraw and send again', async () => {
      const w = await world();
      const sharing = w.sharingFor(OWNER);
      await sharing.invite(vehicle('civic'), PARTNER.email);
      await expect(sharing.invite(vehicle('civic'), PARTNER.email)).rejects.toBeInstanceOf(Refused);
      await sharing.withdrawInvite('civic', PARTNER.email);
      await expect(sharing.invite(vehicle('civic'), PARTNER.email)).resolves.toBeDefined();
    });

    test('not to something that is not an address', async () => {
      const w = await world();
      await expect(w.sharingFor(OWNER).invite(vehicle('civic'), 'not an address')).rejects.toThrow();
      expect(w.invites.size).toBe(0);
    });

    test('found only by the address they were sent to, verified, in any case', async () => {
      const w = await world();
      await w.sharingFor(OWNER).invite(vehicle('civic'), PARTNER.email);
      expect(await w.sharingFor({ ...PARTNER, email: 'SAM@EXAMPLE.COM' }).invitesForMe()).toHaveLength(1);
      expect(await w.sharingFor({ ...PARTNER, emailVerified: false }).invitesForMe()).toHaveLength(0);
      expect(await w.sharingFor(THIRD).invitesForMe()).toHaveLength(0);
    });

    test('the same address can be invited to two cars, and answer each separately', async () => {
      const w = await world();
      const owner = w.sharingFor(OWNER);
      await owner.invite(vehicle('civic'), PARTNER.email);
      await owner.invite(vehicle('truck'), PARTNER.email);
      const partner = w.sharingFor(PARTNER);
      const [first, second] = await partner.invitesForMe();
      await partner.accept(first!);
      await partner.decline(second!);
      expect(await partner.memberships()).toHaveLength(1);
      expect(w.invites.size).toBe(0);
    });
  });

  describe('joining', () => {
    test('uses up the invitation and records the membership', async () => {
      const w = await joined();
      expect(w.invites.size).toBe(0);
      expect(w.isMember(OWNER.uid, 'civic', PARTNER.uid)).toBe(true);
      expect(await w.sharingFor(PARTNER).memberships()).toEqual([
        { ownerUid: OWNER.uid, vehicleId: 'civic', ownerName: 'Kyle', vehicleName: 'civic' },
      ]);
    });

    test('is refused to the wrong address, an unverified one, or after it was withdrawn', async () => {
      const w = await world();
      const invite = await w.sharingFor(OWNER).invite(vehicle('civic'), PARTNER.email);
      await expect(w.sharingFor(THIRD).accept(invite)).rejects.toBeInstanceOf(Refused);
      await expect(w.sharingFor({ ...PARTNER, emailVerified: false }).accept(invite)).rejects.toBeInstanceOf(Refused);
      await w.sharingFor(OWNER).withdrawInvite('civic', PARTNER.email);
      await expect(w.sharingFor(PARTNER).accept(invite)).rejects.toBeInstanceOf(Refused);
    });

    test('an invitation cannot be used twice', async () => {
      const w = await world();
      const invite = await w.sharingFor(OWNER).invite(vehicle('civic'), PARTNER.email);
      await w.sharingFor(PARTNER).accept(invite);
      await expect(w.sharingFor(PARTNER).accept(invite)).rejects.toBeInstanceOf(Refused);
    });

    test('nobody can decline someone else’s invitation', async () => {
      const w = await world();
      const invite = await w.sharingFor(OWNER).invite(vehicle('civic'), PARTNER.email);
      await expect(w.sharingFor(THIRD).decline(invite)).rejects.toBeInstanceOf(Refused);
      expect(w.invites.size).toBe(1);
    });

    test('two people can share one car', async () => {
      const w = await joined();
      const second = await w.sharingFor(OWNER).invite(vehicle('civic'), THIRD.email);
      await w.sharingFor(THIRD).accept(second);
      expect((await w.sharingFor(OWNER).members(OWNER.uid, 'civic')).map((m) => m.uid).sort()).toEqual([
        PARTNER.uid,
        THIRD.uid,
      ]);
      // And each member sees the other.
      expect(await w.sharingFor(PARTNER).members(OWNER.uid, 'civic')).toHaveLength(2);
    });
  });

  describe('the member list', () => {
    test('is closed to anyone who is not the owner or a member', async () => {
      const w = await joined();
      await expect(w.sharingFor(THIRD).members(OWNER.uid, 'civic')).rejects.toBeInstanceOf(Refused);
      await expect(w.sharingFor(PARTNER).members(OWNER.uid, 'truck')).rejects.toBeInstanceOf(Refused);
    });

    test('removing someone who is not a member is harmless', async () => {
      const w = await joined();
      await w.sharingFor(OWNER).removeMember('civic', 'nobody');
      expect(w.isMember(OWNER.uid, 'civic', PARTNER.uid)).toBe(true);
    });

    test('an owner can only remove from their own cars', async () => {
      const w = await joined();
      await w.sharingFor(THIRD).removeMember('civic', PARTNER.uid);
      expect(w.isMember(OWNER.uid, 'civic', PARTNER.uid)).toBe(true);
    });
  });

  describe('the shared car, as a member reaches it', () => {
    test('reads the car and its fill-ups only', async () => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const raw = await w.sharingFor(PARTNER).scoped(membership!).pull(null);
      expect((raw.vehicles as VehicleRecord[]).map((v) => v.id)).toEqual(['civic']);
      expect((raw.fillUps as FillUpRecord[]).map((f) => f.id)).toEqual(['f1']);
      expect(raw.pendingFillUps).toEqual([]);
    });

    test('writes a fill-up entered by themselves', async () => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const scoped = w.sharingFor(PARTNER).scoped(membership!);
      await scoped.push({ vehicles: [], fillUps: [fillUp('f2', 'civic', PARTNER.uid)], pendingFillUps: [] });
      const owner = await w.remoteFor(OWNER.uid).pull(null);
      expect((owner.fillUps as FillUpRecord[]).find((f) => f.id === 'f2')?.enteredBy).toBe(PARTNER.uid);
    });

    test.each([
      ['for another car', fillUp('f2', 'truck', PARTNER.uid)],
      ['claiming the owner entered it', fillUp('f2', 'civic', OWNER.uid)],
      ['entered by nobody', fillUp('f2', 'civic', null)],
      ['moving the owner’s other car’s fill-up in', fillUp('t1', 'civic', OWNER.uid)],
      ['changing who entered an existing one', fillUp('f1', 'civic', PARTNER.uid)],
    ])('refuses a fill-up %s', async (_label, row) => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const scoped = w.sharingFor(PARTNER).scoped(membership!);
      await expect(scoped.push({ vehicles: [], fillUps: [row], pendingFillUps: [] })).rejects.toBeInstanceOf(Refused);
    });

    test('refuses the car itself, and submissions', async () => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const scoped = w.sharingFor(PARTNER).scoped(membership!);
      await expect(scoped.push({ vehicles: [vehicle('civic')], fillUps: [], pendingFillUps: [] })).rejects.toBeInstanceOf(Refused);
    });

    test('an edit that keeps who entered it is accepted', async () => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const edited = { ...fillUp('f1', 'civic', OWNER.uid), odometer: 12_345, updatedAt: 9 };
      await w.sharingFor(PARTNER).scoped(membership!).push({ vehicles: [], fillUps: [edited], pendingFillUps: [] });
      const owner = await w.remoteFor(OWNER.uid).pull(null);
      expect((owner.fillUps as FillUpRecord[]).find((f) => f.id === 'f1')?.odometer).toBe(12_345);
    });

    test('everything is refused once they are removed or leave', async () => {
      const w = await joined();
      const [membership] = await w.sharingFor(PARTNER).memberships();
      const scoped = w.sharingFor(PARTNER).scoped(membership!);
      await w.sharingFor(OWNER).removeMember('civic', PARTNER.uid);
      await expect(scoped.pull(null)).rejects.toBeInstanceOf(Refused);
      await expect(scoped.push({ vehicles: [], fillUps: [], pendingFillUps: [] })).rejects.toBeInstanceOf(Refused);
    });

    test('leaving removes the membership and the access together', async () => {
      const w = await joined();
      const partner = w.sharingFor(PARTNER);
      const [membership] = await partner.memberships();
      await partner.leave(membership!);
      expect(await partner.memberships()).toHaveLength(0);
      expect(w.isMember(OWNER.uid, 'civic', PARTNER.uid)).toBe(false);
      // Leaving twice is harmless.
      await expect(partner.leave(membership!)).resolves.toBeUndefined();
    });
  });
});
