import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxScenarios } from '../collections/tax-scenarios';

/** Saved tax scenarios (TAX-049). */
export default defineMigration({
  id: '20270217100000_tax_scenarios',
  async up(db) {
    await ensureCollection(db, taxScenarios);
  },
});
