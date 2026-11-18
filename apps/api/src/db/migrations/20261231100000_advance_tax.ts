import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { advanceTaxPlans } from '../collections/advance-tax';

/** Advance tax plans (TAX-021). */
export default defineMigration({
  id: '20261231100000_advance_tax',
  async up(db) {
    await ensureCollection(db, advanceTaxPlans);
  },
});
