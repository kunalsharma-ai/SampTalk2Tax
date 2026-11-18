import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Human approval of manual journals (SEC-036): an organisation's policy says from what amount a
 * manual journal needs someone else's approval before it posts; each request covers the draft as
 * it was when requested (its fingerprint), so changing the draft needs a new approval.
 */

export interface JournalApprovalPolicyDoc {
  id: string;
  orgId: string;
  minAmount: string;
  isActive: boolean;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const journalApprovalPolicies = defineCollection<JournalApprovalPolicyDoc>({
  name: 'journal_approval_policies',
  scope: 'tenant',
  decimals: ['minAmount'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'minAmount', 'isActive', 'updatedById', 'createdAt', 'updatedAt'],
    properties: { minAmount: { bsonType: 'decimal' }, isActive: { bsonType: 'bool' } },
  },
  indexes: [{ key: { orgId: 1 }, name: 'one_per_org', unique: true }],
  guards: {
    beforeDelete() {
      throw new GuardViolation('The journal approval policy is switched off, not deleted');
    },
  },
});

export type JournalApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface JournalApprovalDoc {
  id: string;
  orgId: string;
  entryId: string;
  /** SHA-256 of the draft's date, type and lines when the approval was asked for. */
  fingerprint: string;
  total: string;
  status: JournalApprovalStatus;
  /** True while pending or approved: at most one open request per journal. */
  open: boolean;
  note: string | null;
  requestedById: string;
  requestedAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

const MOVES: Record<JournalApprovalStatus, JournalApprovalStatus[]> = { PENDING: ['APPROVED', 'REJECTED', 'CANCELLED'], APPROVED: ['CANCELLED'], REJECTED: [], CANCELLED: [] };

export const journalApprovals = defineCollection<JournalApprovalDoc>({
  name: 'journal_approvals',
  scope: 'tenant',
  decimals: ['total'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'entryId', 'fingerprint', 'total', 'status', 'open', 'requestedById', 'requestedAt'],
    properties: { status: { enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] }, total: { bsonType: 'decimal' }, open: { bsonType: 'bool' } },
  },
  indexes: [
    { key: { orgId: 1, entryId: 1 }, name: 'one_open_per_entry', unique: true, partialFilterExpression: { open: true } },
    { key: { orgId: 1, status: 1, requestedAt: -1 }, name: 'org_status' },
  ],
  guards: {
    beforeInsert(r) {
      if (r.status !== 'PENDING' || !r.open) throw new GuardViolation('A journal approval starts pending');
    },
    afterUpdate(before, after) {
      const fixed = ['orgId', 'entryId', 'fingerprint', 'total', 'requestedById'] as const;
      if (fixed.some((k) => after[k] !== before[k])) throw new GuardViolation('A journal approval request cannot be changed');
      if (after.status !== before.status && !MOVES[before.status].includes(after.status)) throw new GuardViolation(`A journal approval cannot go from ${before.status} to ${after.status}`);
      if (after.open !== (after.status === 'PENDING' || after.status === 'APPROVED')) throw new GuardViolation('Only pending and approved requests are open');
      if (after.status === 'APPROVED' && (!after.decidedById || after.decidedById === after.requestedById)) throw new GuardViolation('A journal is approved by someone other than who asked');
    },
    beforeDelete() {
      throw new GuardViolation('Journal approvals are kept');
    },
  },
});
