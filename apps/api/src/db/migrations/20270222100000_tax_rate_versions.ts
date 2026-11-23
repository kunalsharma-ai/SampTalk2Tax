import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxRateVersions } from '../collections/tax-rate-versions';

/** Tax rate versions (TAX-003). */
export default defineMigration({
  id: '20270222100000_tax_rate_versions',
  async up(db) {
    await ensureCollection(db, taxRateVersions);
  },
});
