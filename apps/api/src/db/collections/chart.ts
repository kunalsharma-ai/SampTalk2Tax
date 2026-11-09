import { defineCollection, GuardViolation, type GuardContext } from '@talk2tax/document-db';
import { organizations } from './tenancy';

/** The chart of accounts and the fiscal calendar: what every posting points at. */

export type AccountTypeName = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
const ACCOUNT_TYPES: AccountTypeName[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

export interface AccountDoc {
  id: string;
  orgId: string;
  code: string;
  name: string;
  type: AccountTypeName;
  subtype: string | null;
  description: string | null;
  parentId: string | null;
  isPostable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Was the accounts parent foreign key: a parent is another account of the same organisation. */
async function checkParent(a: AccountDoc, ctx: GuardContext) {
  if (a.parentId === null) return;
  if (a.parentId === a.id) throw new GuardViolation('An account cannot be its own parent');
  if (!(await ctx.collection(accounts).exists({ id: a.parentId, orgId: a.orgId }))) throw new GuardViolation('The parent account does not exist in this organisation');
}

export const accounts = defineCollection<AccountDoc>({
  name: 'accounts',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['code', 'name', 'type', 'isPostable', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      code: { bsonType: 'string', minLength: 1, maxLength: 20 },
      name: { bsonType: 'string', minLength: 1 },
      type: { enum: ACCOUNT_TYPES },
      subtype: { bsonType: ['string', 'null'] },
      description: { bsonType: ['string', 'null'] },
      parentId: { bsonType: ['string', 'null'] },
      isPostable: { bsonType: 'bool' },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { orgId: 1, code: 1 }, name: 'org_code', unique: true },
    { key: { orgId: 1, type: 1 }, name: 'org_type' },
    { key: { orgId: 1, parentId: 1 }, name: 'org_parent' },
  ],
  guards: {
    beforeInsert: checkParent,
    async afterUpdate(before, after, ctx) {
      if (after.type !== before.type) throw new GuardViolation('The type of an account cannot change');
      if (after.parentId !== before.parentId) await checkParent(after, ctx);
    },
    // Nothing deletes accounts except undoing a change PostgreSQL refused (or a new
    // organisation's set-up). Until the ledger moves, PostgreSQL's foreign keys on the copy keep
    // accounts with postings.
    async beforeDelete(a, ctx) {
      if (await ctx.collection(accounts).exists({ orgId: a.orgId, parentId: a.id })) throw new GuardViolation('An account with child accounts cannot be deleted');
    },
  },
});

export type PeriodStatusName = 'OPEN' | 'LOCKED' | 'CLOSED';

export interface FiscalPeriodDoc {
  id: string;
  orgId: string;
  fiscalYear: number;
  periodNo: number;
  name: string;
  /** UTC midnight of the first and last day (PostgreSQL `date`). */
  startDate: Date;
  endDate: Date;
  status: PeriodStatusName;
  lockedAt: Date | null;
  lockedById: string | null;
}

function checkPeriod(p: FiscalPeriodDoc) {
  if (p.startDate > p.endDate) throw new GuardViolation('A period cannot end before it starts');
  if (p.status === 'OPEN' && (p.lockedAt !== null || p.lockedById !== null)) throw new GuardViolation('An open period has no lock');
  if (p.status === 'LOCKED' && p.lockedAt === null) throw new GuardViolation('A locked period needs its lock time');
}

export const fiscalPeriods = defineCollection<FiscalPeriodDoc>({
  name: 'fiscal_periods',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['fiscalYear', 'periodNo', 'name', 'startDate', 'endDate', 'status'],
    properties: {
      fiscalYear: { bsonType: ['int', 'long'] },
      periodNo: { bsonType: ['int', 'long'], minimum: 1, maximum: 13 },
      name: { bsonType: 'string', minLength: 1 },
      startDate: { bsonType: 'date' },
      endDate: { bsonType: 'date' },
      status: { enum: ['OPEN', 'LOCKED', 'CLOSED'] },
      lockedAt: { bsonType: ['date', 'null'] },
      lockedById: { bsonType: ['string', 'null'] },
    },
  },
  indexes: [
    { key: { orgId: 1, fiscalYear: 1, periodNo: 1 }, name: 'org_year_no', unique: true },
    { key: { orgId: 1, startDate: 1 }, name: 'org_start' },
  ],
  guards: {
    async beforeInsert(p, ctx) {
      checkPeriod(p);
      // Was the fiscal_periods_no_overlap exclusion constraint. Bumping a counter on the
      // organisation makes two calendars added at once conflict, so the second one sees the first.
      await ctx.collection(organizations).updateOne({ id: p.orgId }, { $inc: { periodChanges: 1 } });
      const overlap = await ctx.collection(fiscalPeriods).findOne({ orgId: p.orgId, startDate: { $lte: p.endDate }, endDate: { $gte: p.startDate } });
      if (overlap) throw new GuardViolation(`The period overlaps ${overlap.name}`);
    },
    afterUpdate(before, after) {
      if (before.status === 'CLOSED') throw new GuardViolation('A closed period cannot change');
      if (after.fiscalYear !== before.fiscalYear || after.periodNo !== before.periodNo || after.startDate.getTime() !== before.startDate.getTime() || after.endDate.getTime() !== before.endDate.getTime()) {
        throw new GuardViolation("A period's dates cannot change");
      }
      checkPeriod(after);
    },
    beforeDelete(p) {
      if (p.status !== 'OPEN') throw new GuardViolation('A locked or closed period cannot be deleted');
    },
  },
});
