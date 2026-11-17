import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Expense policy rules (EXP-013, EXP-015, EXP-022): spending limits and other checks every
 * claim is held to. Finance sets them; each rule warns or blocks.
 */

export type PolicyKindName = 'LINE_MAX' | 'DAILY_MAX' | 'MONTHLY_MAX' | 'CLAIM_MAX' | 'RECEIPT_ABOVE' | 'MAX_AGE_DAYS';

export interface ExpensePolicyRuleDoc {
  id: string;
  orgId: string;
  kind: PolicyKindName;
  severity: 'WARN' | 'BLOCK';
  accountId: string | null;
  amount: string | null;
  days: number | null;
  isActive: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const expensePolicyRules = defineCollection<ExpensePolicyRuleDoc>({
  name: 'expense_policy_rules',
  scope: 'tenant',
  decimals: ['amount'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'kind', 'severity', 'isActive', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      kind: { enum: ['LINE_MAX', 'DAILY_MAX', 'MONTHLY_MAX', 'CLAIM_MAX', 'RECEIPT_ABOVE', 'MAX_AGE_DAYS'] },
      severity: { enum: ['WARN', 'BLOCK'] },
      accountId: { bsonType: ['string', 'null'] },
      amount: { bsonType: ['decimal', 'null'] },
      days: { bsonType: ['int', 'long', 'null'], minimum: 1, maximum: 3650 },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, isActive: 1, kind: 1 }, name: 'org_active_kind' }],
  guards: {
    beforeInsert(doc) {
      if ((doc.kind === 'MAX_AGE_DAYS') !== (doc.days != null)) throw new GuardViolation('Only a receipt age rule takes days');
      if ((doc.kind === 'MAX_AGE_DAYS') === (doc.amount != null)) throw new GuardViolation('Every rule but receipt age takes an amount');
    },
    afterUpdate(before, after) {
      if (after.kind !== before.kind) throw new GuardViolation('A rule cannot change what it checks; add a new rule instead');
    },
  },
});
