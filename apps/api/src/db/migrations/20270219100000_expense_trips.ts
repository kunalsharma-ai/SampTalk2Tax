import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { expenseTrips } from '../collections/expense-trips';

/** Business trips (EXP-007). */
export default defineMigration({
  id: '20270219100000_expense_trips',
  async up(db) {
    await ensureCollection(db, expenseTrips);
  },
});
