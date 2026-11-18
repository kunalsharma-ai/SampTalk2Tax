import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Cost allocation (GL-024): rules that spread shared costs from one cost centre (department), or
 * from costs with none, to others by fixed percentages; and the runs that posted them for a
 * period. A rule is switched off, not deleted; a run is reversed, not deleted.
 */

export interface CostAllocationRuleDoc {
  id: string;
  orgId: string;
  name: string;
  accountIds: string[];
  /** The department the costs sit in; null for costs not tagged to any department. */
  sourceDepartmentId: string | null;
  targets: { departmentId: string; percent: string }[];
  isActive: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const costAllocationRules = defineCollection<CostAllocationRuleDoc>({
  name: 'cost_allocation_rules',
  scope: 'tenant',
  decimals: ['targets[].percent'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'accountIds', 'sourceDepartmentId', 'targets', 'isActive', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 100 },
      accountIds: { bsonType: 'array', minItems: 1, maxItems: 100 },
      sourceDepartmentId: { bsonType: ['string', 'null'] },
      targets: { bsonType: 'array', minItems: 2, maxItems: 50 },
      isActive: { bsonType: 'bool' },
    },
  },
  indexes: [{ key: { orgId: 1, name: 1 }, name: 'org_name', unique: true, collation: { locale: 'en', strength: 2 } }],
  guards: {
    beforeDelete() {
      throw new GuardViolation('An allocation rule is switched off, not deleted');
    },
  },
});

export interface CostAllocationRunDoc {
  id: string;
  orgId: string;
  ruleId: string;
  ruleName: string;
  from: Date;
  to: Date;
  journalEntryId: string;
  total: string;
  status: 'POSTED' | 'REVERSED';
  reversalEntryId: string | null;
  reversedById: string | null;
  reversedAt: Date | null;
  postedById: string;
  postedAt: Date;
}

export const costAllocationRuns = defineCollection<CostAllocationRunDoc>({
  name: 'cost_allocation_runs',
  scope: 'tenant',
  decimals: ['total'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'ruleId', 'ruleName', 'from', 'to', 'journalEntryId', 'total', 'status', 'postedById', 'postedAt'],
    properties: {
      from: { bsonType: 'date' },
      to: { bsonType: 'date' },
      status: { enum: ['POSTED', 'REVERSED'] },
    },
  },
  indexes: [
    // One posted run of a rule for a period; a reversed run frees the period for another.
    { key: { orgId: 1, ruleId: 1, from: 1, to: 1 }, name: 'posted_once', unique: true, partialFilterExpression: { status: 'POSTED' } },
    { key: { orgId: 1, postedAt: -1 }, name: 'org_posted' },
  ],
  guards: {
    afterUpdate(before, after) {
      const fixed = ['orgId', 'ruleId', 'journalEntryId', 'total', 'postedById'] as const;
      if (fixed.some((k) => after[k] !== before[k]) || before.status !== 'POSTED' || after.status !== 'REVERSED' || !after.reversalEntryId) throw new GuardViolation('A run is only ever reversed, with its reversing journal');
    },
    beforeDelete() {
      throw new GuardViolation('An allocation run is reversed, not deleted');
    },
  },
});
