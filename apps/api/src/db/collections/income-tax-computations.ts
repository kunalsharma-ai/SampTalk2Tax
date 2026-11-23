import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Income tax computations (TAX-019, TAX-020): the preparer's inputs for one financial year's
 * computation of total income (regime, depreciation under section 32, brought forward loss, other
 * additions and deductions, other tax paid). While a draft the computation is worked out from the
 * books whenever it is read; finalising freezes it, and a final computation is never changed or
 * deleted.
 */
export interface ComputationAdjustmentDoc {
  label: string;
  section: string | null;
  kind: 'ADD' | 'DEDUCT';
  amount: string;
}

export interface IncomeTaxComputationDoc {
  id: string;
  orgId: string;
  /** "2025-26" */
  taxYear: string;
  regime: string;
  taxDepreciation: string | null;
  broughtForwardLoss: string;
  adjustments: ComputationAdjustmentDoc[];
  otherCredits: string;
  status: 'DRAFT' | 'FINAL';
  snapshot: Record<string, unknown> | null;
  createdById: string;
  createdAt: Date;
  updatedById: string;
  updatedAt: Date;
  finalisedById: string | null;
  finalisedAt: Date | null;
}

const AMOUNT = { bsonType: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' };

export const incomeTaxComputations = defineCollection<IncomeTaxComputationDoc>({
  name: 'income_tax_computations',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'taxYear', 'regime', 'broughtForwardLoss', 'adjustments', 'otherCredits', 'status', 'createdById', 'createdAt', 'updatedById', 'updatedAt'],
    properties: {
      taxYear: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
      regime: { enum: ['COMPANY_22', 'COMPANY_25', 'COMPANY_30', 'FIRM_30'] },
      taxDepreciation: { bsonType: ['string', 'null'], pattern: '^[0-9]+(\\.[0-9]+)?$' },
      broughtForwardLoss: AMOUNT,
      otherCredits: AMOUNT,
      status: { enum: ['DRAFT', 'FINAL'] },
      adjustments: {
        bsonType: 'array',
        maxItems: 50,
        items: { bsonType: 'object', required: ['label', 'kind', 'amount'], properties: { label: { bsonType: 'string', minLength: 1, maxLength: 200 }, section: { bsonType: ['string', 'null'], maxLength: 20 }, kind: { enum: ['ADD', 'DEDUCT'] }, amount: AMOUNT } },
      },
      snapshot: { bsonType: ['object', 'null'] },
    },
  },
  indexes: [{ key: { orgId: 1, taxYear: 1 }, name: 'one_computation_a_year', unique: true }],
  guards: {
    beforeInsert(c) {
      if (c.status !== 'DRAFT' || c.snapshot) throw new GuardViolation('A computation starts as a draft');
    },
    afterUpdate(before, after) {
      if (before.status === 'FINAL') throw new GuardViolation('A final computation is kept as it was');
      if (before.taxYear !== after.taxYear) throw new GuardViolation('A computation keeps its year');
      if (after.status === 'FINAL' && (!after.snapshot || !after.finalisedById || !after.finalisedAt)) throw new GuardViolation('A computation is finalised with its figures, who and when');
    },
    beforeDelete() {
      throw new GuardViolation('Income tax computations are kept as a record');
    },
  },
});
