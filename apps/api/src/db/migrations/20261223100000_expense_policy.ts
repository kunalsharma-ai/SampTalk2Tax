import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { expensePolicyRules } from '../collections/expense-policy';

/** Expense policy: spending limits and other rules claims are checked against. */
export default defineMigration({
  id: '20261223100000_expense_policy',
  async up(db) {
    await ensureCollection(db, expensePolicyRules);
  },
});
