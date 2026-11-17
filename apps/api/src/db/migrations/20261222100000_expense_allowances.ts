import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { allowanceRates, claimAllowances } from '../collections/allowances';

/** Mileage and per diem: the organisation's rates, and what each allowance line was worked out from. */
export default defineMigration({
  id: '20261222100000_expense_allowances',
  async up(db) {
    for (const def of [allowanceRates, claimAllowances]) await ensureCollection(db, def);
  },
});
