import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Expense categories (EXP-005): the list employees claim under, each posting to one expense
 * account. Archived, never deleted, so old claim lines keep their category's name.
 */
export interface ExpenseCategoryDoc {
  id: string;
  orgId: string;
  name: string;
  /** The name with case and spaces ignored; unique among active categories. */
  nameKey: string;
  description: string | null;
  accountId: string;
  taxRateId: string | null;
  /** POLICY: the expense policy decides; ALWAYS: a claim with a line here needs a receipt to be submitted. */
  receipt: 'POLICY' | 'ALWAYS';
  isActive: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const expenseCategories = defineCollection<ExpenseCategoryDoc>({
  name: 'expense_categories',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'nameKey', 'accountId', 'receipt', 'isActive', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 60 },
      nameKey: { bsonType: 'string', minLength: 1, maxLength: 60 },
      description: { bsonType: ['string', 'null'], maxLength: 500 },
      accountId: { bsonType: 'string' },
      taxRateId: { bsonType: ['string', 'null'] },
      receipt: { enum: ['POLICY', 'ALWAYS'] },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, nameKey: 1 }, name: 'org_active_name', unique: true, partialFilterExpression: { isActive: true } }],
  guards: {
    beforeDelete() {
      throw new GuardViolation('Expense categories are archived, not deleted');
    },
  },
});
