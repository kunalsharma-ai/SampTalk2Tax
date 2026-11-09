import { defineCollection, GuardViolation, type GuardContext } from '@talk2tax/document-db';

/** Organisations, who belongs to them, and invitations to join. */

export type RoleName = 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER' | 'VIEWER' | 'EMPLOYEE';
const ROLES: RoleName[] = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'];
const TIME_ZONE = '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$';

export interface OrganizationDoc {
  id: string;
  name: string;
  legalName: string | null;
  timeZone: string;
  countryCode: string;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
  isDemo: boolean;
  /** The region this organisation's data lives in. Once set, it can change (a move) but never be cleared. */
  dataRegion: string | null;
  /** Suspended by the platform: readable by members, not changeable. */
  suspendedAt: Date | null;
  suspendedReason: string | null;
  /** Receivables / payables / employee reimbursements control accounts. */
  arAccountId: string | null;
  apAccountId: string | null;
  claimsAccountId: string | null;
  /** Bumped by every owner change, so two owner changes at once conflict and run one after the other. */
  ownerChanges?: number;
  createdAt: Date;
  updatedAt: Date;
}

function checkSuspension(o: OrganizationDoc) {
  const suspended = o.suspendedAt !== null;
  if (suspended !== (o.suspendedReason !== null && o.suspendedReason.trim().length > 0)) {
    throw new GuardViolation('A suspended organisation needs a reason, and only a suspended one has one');
  }
}

/** Global: an organisation is the tenant itself. Code reaches one only by an id it has checked. */
export const organizations = defineCollection<OrganizationDoc>({
  name: 'organizations',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['name', 'timeZone', 'countryCode', 'functionalCurrency', 'fiscalYearStartMonth', 'isDemo', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1 },
      legalName: { bsonType: ['string', 'null'] },
      timeZone: { bsonType: 'string', pattern: TIME_ZONE },
      countryCode: { bsonType: 'string', pattern: '^[A-Z]{2}$' },
      functionalCurrency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      fiscalYearStartMonth: { bsonType: ['int', 'long'], minimum: 1, maximum: 12 },
      isDemo: { bsonType: 'bool' },
      dataRegion: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[a-z0-9-]{2,32}$' }] },
      suspendedAt: { bsonType: ['date', 'null'] },
      suspendedReason: { bsonType: ['string', 'null'] },
      arAccountId: { bsonType: ['string', 'null'] },
      apAccountId: { bsonType: ['string', 'null'] },
      claimsAccountId: { bsonType: ['string', 'null'] },
      ownerChanges: { bsonType: ['int', 'long'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { dataRegion: 1 }, name: 'data_region' }],
  guards: {
    beforeInsert: checkSuspension,
    afterUpdate(before, after) {
      // Was the organizations_data_region_kept trigger.
      if (before.dataRegion !== null && after.dataRegion === null) throw new GuardViolation("An organisation's data region cannot be cleared");
      checkSuspension(after);
    },
  },
});

export interface MembershipDoc {
  id: string;
  orgId: string;
  userId: string;
  role: RoleName;
  createdAt: Date;
}

/** Was the memberships_last_owner trigger: an organisation always keeps at least one owner. */
async function keepAnOwner(m: MembershipDoc, ctx: GuardContext) {
  // Like SELECT … FOR UPDATE on the organisation: two owner changes at once write the same
  // document, so one of them is retried and then sees the other's change.
  await ctx.collection(organizations).updateOne({ id: m.orgId }, { $inc: { ownerChanges: 1 } });
  const others = await ctx.collection(memberships).count({ orgId: m.orgId, role: 'OWNER', id: { $ne: m.id } });
  const orgExists = await ctx.collection(organizations).exists({ id: m.orgId });
  if (orgExists && others === 0) throw new GuardViolation('An organisation must keep at least one owner');
}

export const memberships = defineCollection<MembershipDoc>({
  name: 'memberships',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['userId', 'role', 'createdAt'],
    properties: { userId: { bsonType: 'string' }, role: { enum: ROLES }, createdAt: { bsonType: 'date' } },
  },
  indexes: [
    { key: { orgId: 1, userId: 1 }, name: 'org_user', unique: true },
    { key: { userId: 1 }, name: 'user' },
  ],
  guards: {
    async afterUpdate(before, after, ctx) {
      if (after.userId !== before.userId) throw new GuardViolation('A membership cannot change its person');
      if (before.role === 'OWNER' && after.role !== 'OWNER') await keepAnOwner(before, ctx);
    },
    async beforeDelete(m, ctx) {
      if (m.role === 'OWNER') await keepAnOwner(m, ctx);
    },
  },
});

export interface InvitationDoc {
  id: string;
  orgId: string;
  /** Lower-case. */
  email: string;
  role: RoleName;
  /** SHA-256 of the link token; unique. */
  tokenHash: string;
  invitedById: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedById: string | null;
  revokedAt: Date | null;
  revokedById: string | null;
  /** The email while the invitation is open, absent once accepted or revoked: one open invitation per address. */
  openFor?: string;
}

function checkInvitation(i: InvitationDoc) {
  const ok =
    !(i.acceptedAt && i.revokedAt) &&
    (i.acceptedAt === null) === (i.acceptedById === null) &&
    (i.revokedAt === null) === (i.revokedById === null) &&
    i.expiresAt > i.createdAt &&
    (i.openFor === undefined) === Boolean(i.acceptedAt || i.revokedAt) &&
    (i.openFor === undefined || i.openFor === i.email);
  if (!ok) throw new GuardViolation('Invitation state is inconsistent');
}

export const invitations = defineCollection<InvitationDoc>({
  name: 'invitations',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['email', 'role', 'tokenHash', 'invitedById', 'createdAt', 'expiresAt'],
    properties: {
      email: { bsonType: 'string', pattern: '^[^A-Z@]+@[^A-Z]+$' },
      role: { enum: ROLES },
      tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      invitedById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      expiresAt: { bsonType: 'date' },
      acceptedAt: { bsonType: ['date', 'null'] },
      acceptedById: { bsonType: ['string', 'null'] },
      revokedAt: { bsonType: ['date', 'null'] },
      revokedById: { bsonType: ['string', 'null'] },
      openFor: { bsonType: 'string' },
    },
  },
  indexes: [
    { key: { tokenHash: 1 }, name: 'token', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'org_created' },
    { key: { orgId: 1, openFor: 1 }, name: 'one_open', unique: true, partialFilterExpression: { openFor: { $exists: true } } },
  ],
  guards: {
    beforeInsert: checkInvitation,
    // Was the invitations_guard trigger: accepted or revoked invitations are history. Open
    // ones may only get a new token and expiry, or be accepted or revoked.
    afterUpdate(before, after) {
      if (before.acceptedAt || before.revokedAt) throw new GuardViolation(`Invitation is already ${before.acceptedAt ? 'accepted' : 'revoked'}`);
      if (after.orgId !== before.orgId || after.email !== before.email || after.role !== before.role || after.invitedById !== before.invitedById || after.createdAt.getTime() !== before.createdAt.getTime()) {
        throw new GuardViolation('Invitation email, role and organisation cannot change');
      }
      checkInvitation(after);
    },
    beforeDelete() {
      throw new GuardViolation('Invitations cannot be deleted; revoke them instead');
    },
  },
});
