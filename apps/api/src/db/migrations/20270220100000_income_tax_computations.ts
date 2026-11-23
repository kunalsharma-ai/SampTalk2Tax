import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { incomeTaxComputations } from '../collections/income-tax-computations';

/** Income tax computations (TAX-019, TAX-020). */
export default defineMigration({
  id: '20270220100000_income_tax_computations',
  async up(db) {
    await ensureCollection(db, incomeTaxComputations);
  },
});
