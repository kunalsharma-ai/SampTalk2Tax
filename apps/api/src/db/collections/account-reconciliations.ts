import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Balance sheet account reconciliations (GL-032, GL-023): for one account at one date, the items
 * that explain its ledger balance, who prepared the work and who reviewed it. The ledger balance
 * is kept as it was when the work was last saved, so a later posting into the period shows up as
 * a change. A reviewed reconciliation is not edited; it is reopened, and its history only grows.
 */

export type AccountReconStatus = 'DRAFT' | 'PREPARED' | 'REVIEWED';
export type AccountReconEventKind = 'SAVED' | 'PREPARED' | 'REVIEWED' | 'REOPENED';

export interface AccountReconItem {
  id: string;
  description: string;
  reference: string | null;
  amount: string;
  kind: 'SUPPORT' | 'RECONCILING';
}

export interface AccountReconEvent {
  id: string;
  kind: AccountReconEventKind;
  note: string | null;
  byId: string;
  at: Date;
}

export interface AccountReconciliationDoc {
  id: string;
  orgId: string;
  accountId: string;
  asOf: Date;
  ledgerBalance: string;
  /** For the receivable and payable control accounts: the open items in the subsidiary ledger. */
  subledgerBalance: string | null;
  items: AccountReconItem[];
  difference: string;
  status: AccountReconStatus;
  notes: string | null;
  preparedById: string | null;
  preparedAt: Date | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  events: AccountReconEvent[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

const FIXED = ['orgId', 'accountId', 'createdById'] as const;

export const accountReconciliations = defineCollection<AccountReconciliationDoc>({
  name: 'account_reconciliations',
  scope: 'tenant',
  decimals: ['ledgerBalance', 'subledgerBalance', 'difference', 'items[].amount'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'accountId', 'asOf', 'ledgerBalance', 'items', 'difference', 'status', 'events', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      asOf: { bsonType: 'date' },
      status: { enum: ['DRAFT', 'PREPARED', 'REVIEWED'] },
      items: { bsonType: 'array', maxItems: 500 },
      notes: { bsonType: ['string', 'null'], maxLength: 2000 },
      events: { bsonType: 'array', minItems: 1 },
    },
  },
  indexes: [
    { key: { orgId: 1, accountId: 1, asOf: 1 }, name: 'org_account_asof', unique: true },
    { key: { orgId: 1, asOf: 1, status: 1 }, name: 'org_asof_status' },
  ],
  guards: {
    beforeInsert(n) {
      if (n.status !== 'DRAFT') throw new GuardViolation('A reconciliation starts as a draft');
    },
    afterUpdate(before, after) {
      if (FIXED.some((k) => after[k] !== before[k]) || after.asOf.getTime() !== before.asOf.getTime()) throw new GuardViolation('A reconciliation keeps its account and date');
      if (after.events.length <= before.events.length || before.events.some((e, i) => after.events[i]?.id !== e.id)) throw new GuardViolation('Every change to a reconciliation adds to its history');
      if (before.status === 'REVIEWED' && after.status !== 'DRAFT') throw new GuardViolation('A reviewed reconciliation is reopened before it changes');
      if (after.status !== 'DRAFT' && after.difference !== '0' && !/^-?0(\.0+)?$/.test(after.difference)) throw new GuardViolation('Only a balanced reconciliation is signed off');
      if (after.status === 'REVIEWED' && (!after.reviewedById || after.reviewedById === after.preparedById)) throw new GuardViolation('A reconciliation is reviewed by someone other than its preparer');
    },
    beforeDelete() {
      throw new GuardViolation('A reconciliation is kept; reopen it instead');
    },
  },
});
