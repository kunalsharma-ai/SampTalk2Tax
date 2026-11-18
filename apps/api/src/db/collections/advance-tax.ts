import { defineCollection } from '@talk2tax/document-db';

/**
 * Advance tax plans (TAX-021): per tax year, how the organisation estimates the year's income and
 * where its advance tax payments and tax credits sit in the books. The figures themselves are
 * worked out from the books each time they are read.
 */
export interface AdvanceTaxPlanDoc {
  id: string;
  orgId: string;
  /** The tax year as 2026-27. */
  taxYear: string;
  regime: 'COMPANY_22' | 'COMPANY_25' | 'COMPANY_30' | 'FIRM_30';
  method: 'ANNUALISE' | 'ESTIMATE';
  /** The organisation's own estimate of the year's profit before adjustments, for ESTIMATE. */
  estimatedIncome: string | null;
  /** Additions (positive) and deductions (negative) from book profit to taxable income. */
  adjustments: { label: string; amount: string }[];
  /** The asset account advance tax payments are debited to. */
  paidAccountId: string | null;
  /** The asset account tax deducted or collected at source from the organisation sits in. */
  tdsAccountId: string | null;
  /** Other tax credits for the year not in that account. */
  otherCredits: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const advanceTaxPlans = defineCollection<AdvanceTaxPlanDoc>({
  name: 'advance_tax_plans',
  scope: 'tenant',
  decimals: ['estimatedIncome', 'adjustments[].amount', 'otherCredits'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'taxYear', 'regime', 'method', 'estimatedIncome', 'adjustments', 'paidAccountId', 'tdsAccountId', 'otherCredits', 'updatedById', 'createdAt', 'updatedAt'],
    properties: {
      taxYear: { bsonType: 'string', pattern: '^[0-9]{4}-[0-9]{2}$' },
      regime: { enum: ['COMPANY_22', 'COMPANY_25', 'COMPANY_30', 'FIRM_30'] },
      method: { enum: ['ANNUALISE', 'ESTIMATE'] },
      adjustments: { bsonType: 'array', maxItems: 30 },
      paidAccountId: { bsonType: ['string', 'null'] },
      tdsAccountId: { bsonType: ['string', 'null'] },
    },
  },
  indexes: [{ key: { orgId: 1, taxYear: 1 }, name: 'org_year', unique: true }],
});
