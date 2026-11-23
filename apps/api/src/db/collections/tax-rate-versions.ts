import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Tax rate versions (TAX-003): later percentages for a tax rate, each with the date it takes
 * effect and why. The rate's original percentage is version 1. Versions are only appended, in date
 * order; one can be withdrawn (never deleted) only before it takes effect.
 */
export interface TaxRateVersionDoc {
  id: string;
  orgId: string;
  taxRateId: string;
  /** Percentage as a decimal string. */
  rate: string;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  reason: string;
  status: 'ACTIVE' | 'WITHDRAWN';
  withdrawnReason: string | null;
  withdrawnById: string | null;
  withdrawnAt: Date | null;
  createdById: string;
  createdAt: Date;
}

export const taxRateVersions = defineCollection<TaxRateVersionDoc>({
  name: 'tax_rate_versions',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'taxRateId', 'rate', 'effectiveFrom', 'reason', 'status', 'createdById', 'createdAt'],
    properties: {
      taxRateId: { bsonType: 'string' },
      rate: { bsonType: 'string', pattern: '^[0-9]{1,3}(\\.[0-9]{1,6})?$' },
      effectiveFrom: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      reason: { bsonType: 'string', minLength: 3, maxLength: 500 },
      status: { enum: ['ACTIVE', 'WITHDRAWN'] },
      withdrawnReason: { bsonType: ['string', 'null'], maxLength: 500 },
    },
  },
  indexes: [{ key: { orgId: 1, taxRateId: 1, effectiveFrom: 1 }, name: 'versions_by_rate' }],
  guards: {
    beforeInsert(v) {
      if (v.status !== 'ACTIVE' || v.withdrawnAt) throw new GuardViolation('A version starts active');
    },
    afterUpdate(before, after) {
      if (before.status === 'WITHDRAWN') throw new GuardViolation('A withdrawn version stays as it was');
      if (before.rate !== after.rate || before.effectiveFrom !== after.effectiveFrom || before.taxRateId !== after.taxRateId || before.reason !== after.reason) throw new GuardViolation('A version is never rewritten; withdraw it and add another');
      if (after.status === 'WITHDRAWN' && (!after.withdrawnReason || !after.withdrawnById || !after.withdrawnAt)) throw new GuardViolation('Withdrawing a version needs the reason, who and when');
    },
    beforeDelete() {
      throw new GuardViolation('Tax rate versions are kept as a record');
    },
  },
});
