import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { departmentBudgets } from '../collections/department-budgets';

/** Department budgets (EXP-014). */
export default defineMigration({
  id: '20270213100000_department_budgets',
  async up(db) {
    await ensureCollection(db, departmentBudgets);
  },
});
