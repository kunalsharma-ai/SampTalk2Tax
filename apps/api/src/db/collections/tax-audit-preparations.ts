import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Tax audit preparations (TAX-051): for one financial year, the preparer's notes to the auditor on
 * the readiness checks, and whether the year was marked ready for the auditor (with the checks as
 * they stood). The checks themselves are worked out from the books whenever they are read. Notes
 * are frozen while the year is marked ready; reopening needs a reason. Never deleted.
 */
export interface PrepNoteDoc {
  key: string;
  note: string;
  byId: string;
  at: Date;
}

export interface TaxAuditPreparationDoc {
  id: string;
  orgId: string;
  /** "2025-26" */
  taxYear: string;
  notes: PrepNoteDoc[];
  status: 'OPEN' | 'READY';
  snapshot: Record<string, unknown> | null;
  readyById: string | null;
  readyAt: Date | null;
  reopenedReason: string | null;
  reopenedById: string | null;
  reopenedAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const taxAuditPreparations = defineCollection<TaxAuditPreparationDoc>({
  name: 'tax_audit_preparations',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'taxYear', 'notes', 'status', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      taxYear: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
      status: { enum: ['OPEN', 'READY'] },
      notes: {
        bsonType: 'array',
        maxItems: 20,
        items: { bsonType: 'object', required: ['key', 'note', 'byId', 'at'], properties: { key: { bsonType: 'string', pattern: '^[A-Z_]{3,40}$' }, note: { bsonType: 'string', minLength: 1, maxLength: 2000 }, byId: { bsonType: 'string' }, at: { bsonType: 'date' } } },
      },
      snapshot: { bsonType: ['object', 'null'] },
      reopenedReason: { bsonType: ['string', 'null'], maxLength: 500 },
    },
  },
  indexes: [{ key: { orgId: 1, taxYear: 1 }, name: 'one_preparation_a_year', unique: true }],
  guards: {
    beforeInsert(p) {
      if (p.status !== 'OPEN' || p.snapshot) throw new GuardViolation('A preparation starts open');
    },
    afterUpdate(before, after) {
      if (before.taxYear !== after.taxYear) throw new GuardViolation('A preparation keeps its year');
      if (after.status === 'READY' && (!after.snapshot || !after.readyById || !after.readyAt)) throw new GuardViolation('A year is marked ready with its checks, who and when');
      if (before.status === 'READY' && after.status === 'READY' && JSON.stringify(before.notes) !== JSON.stringify(after.notes)) throw new GuardViolation('Notes are frozen while the year is marked ready');
      if (before.status === 'READY' && after.status === 'OPEN' && (!after.reopenedReason || !after.reopenedById)) throw new GuardViolation('Reopening needs a reason and who');
    },
    beforeDelete() {
      throw new GuardViolation('Tax audit preparations are kept as a record');
    },
  },
});
