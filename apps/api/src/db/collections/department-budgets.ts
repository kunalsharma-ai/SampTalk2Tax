import { defineCollection } from '@talk2tax/document-db';

/**
 * Department budgets (EXP-014): what each department (cost centre) may spend on expenses in a
 * fiscal year. One per department and year; each change is in the audit trail with the old and
 * new amounts.
 */
export interface DepartmentBudgetDoc {
  id: string;
  orgId: string;
  departmentId: string;
  /** Labelled by the calendar year the fiscal year ends in. */
  fiscalYear: number;
  amount: string;
  note: string | null;
  setById: string;
  setAt: Date;
}

export const departmentBudgets = defineCollection<DepartmentBudgetDoc>({
  name: 'department_budgets',
  scope: 'tenant',
  decimals: ['amount'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'departmentId', 'fiscalYear', 'amount', 'setById', 'setAt'],
    properties: {
      departmentId: { bsonType: 'string' },
      fiscalYear: { bsonType: ['int', 'long'], minimum: 2000, maximum: 2200 },
      amount: { bsonType: 'decimal' },
      note: { bsonType: ['string', 'null'], maxLength: 500 },
      setAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, departmentId: 1, fiscalYear: 1 }, name: 'org_department_year', unique: true }],
});
