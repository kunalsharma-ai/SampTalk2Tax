import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Tax scenarios (TAX-049): named what-if changes to a tax year's business, worked out against the
 * year's advance tax estimate whenever they are read. Planning data: a scenario is saved once and
 * may be deleted (both kept in the audit trail), never edited.
 */
export interface TaxScenarioDoc {
  id: string;
  orgId: string;
  taxYear: string;
  name: string;
  regime: string | null;
  revenueChange: string;
  revenueGstRate: string;
  expenseChange: string;
  expenseGstRate: string;
  extraDepreciation: string;
  disallowed: string;
  note: string | null;
  createdById: string;
  createdAt: Date;
}

const SIGNED = '^-?[0-9]+(\\.[0-9]+)?$';
const AMOUNT = '^[0-9]+(\\.[0-9]+)?$';

export const taxScenarios = defineCollection<TaxScenarioDoc>({
  name: 'tax_scenarios',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'taxYear', 'name', 'revenueChange', 'revenueGstRate', 'expenseChange', 'expenseGstRate', 'extraDepreciation', 'disallowed', 'createdById', 'createdAt'],
    properties: {
      taxYear: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
      name: { bsonType: 'string', minLength: 1, maxLength: 100 },
      regime: { bsonType: ['string', 'null'] },
      revenueChange: { bsonType: 'string', pattern: SIGNED },
      expenseChange: { bsonType: 'string', pattern: SIGNED },
      extraDepreciation: { bsonType: 'string', pattern: AMOUNT },
      disallowed: { bsonType: 'string', pattern: AMOUNT },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [{ key: { orgId: 1, taxYear: 1, name: 1 }, name: 'one_name_a_year', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A tax scenario is not edited; save a new one');
    },
  },
});
