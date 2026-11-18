import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Mileage and per diem (EXP-006, EXP-008). The organisation sets rates; an employee claims a
 * distance or days at one of them. The claim line itself is an ordinary expense claim line
 * (amount, expense account); the allowance details behind it are kept beside it here.
 */

export type AllowanceKindName = 'MILEAGE' | 'PER_DIEM';

export interface AllowanceRateDoc {
  id: string;
  orgId: string;
  kind: AllowanceKindName;
  name: string;
  /** Per kilometre (mileage) or per day (per diem). */
  rate: string;
  /** The expense account the claim line posts to. */
  accountId: string;
  isActive: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const allowanceRates = defineCollection<AllowanceRateDoc>({
  name: 'expense_allowance_rates',
  scope: 'tenant',
  decimals: ['rate'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'kind', 'name', 'rate', 'accountId', 'isActive', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      kind: { enum: ['MILEAGE', 'PER_DIEM'] },
      name: { bsonType: 'string', minLength: 1, maxLength: 80 },
      rate: { bsonType: 'decimal' },
      accountId: { bsonType: 'string' },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, kind: 1, name: 1 }, name: 'org_kind_name', unique: true, collation: { locale: 'en', strength: 2 } }],
  guards: {
    afterUpdate(before, after) {
      if (after.kind !== before.kind) throw new GuardViolation('A rate cannot change between mileage and per diem; add a new rate instead');
    },
  },
});

/** What a mileage or per diem line of a claim was worked out from. Replaced whenever the claim's lines are saved. */
export interface ClaimAllowanceDoc {
  id: string;
  orgId: string;
  claimId: string;
  lineNo: number;
  kind: AllowanceKindName;
  rateId: string;
  rateName: string;
  rate: string;
  unit: 'KM' | 'DAY';
  quantity: string;
  from: string | null;
  to: string | null;
  purpose: string | null;
  amount: string;
  createdAt: Date;
}

export const claimAllowances = defineCollection<ClaimAllowanceDoc>({
  name: 'expense_claim_allowances',
  scope: 'tenant',
  decimals: ['rate', 'quantity', 'amount'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'claimId', 'lineNo', 'kind', 'rateId', 'rateName', 'rate', 'unit', 'quantity', 'amount', 'createdAt'],
    properties: {
      claimId: { bsonType: 'string' },
      lineNo: { bsonType: ['int', 'long'], minimum: 1 },
      kind: { enum: ['MILEAGE', 'PER_DIEM'] },
      unit: { enum: ['KM', 'DAY'] },
      rate: { bsonType: 'decimal' },
      quantity: { bsonType: 'decimal' },
      amount: { bsonType: 'decimal' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, claimId: 1, lineNo: 1 }, name: 'org_claim_line', unique: true }],
  guards: {
    // The details of a claim line are written once; saving the claim again replaces them.
    afterUpdate() {
      throw new GuardViolation('Allowance details are replaced with the claim lines, never edited');
    },
  },
});
