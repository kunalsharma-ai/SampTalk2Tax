import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { expenseCategories } from '../collections/expense-categories';

/** Expense categories (EXP-005). */
export default defineMigration({
  id: '20270227100000_expense_categories',
  async up(db) {
    await ensureCollection(db, expenseCategories);
  },
});
