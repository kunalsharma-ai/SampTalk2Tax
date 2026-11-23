import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vatReturns, vatSettings } from '../collections/vat-returns';

/** UK VAT settings and submitted VAT returns (TAX-030). */
export default defineMigration({
  id: '20270301100000_vat_returns',
  async up(db) {
    await ensureCollection(db, vatSettings);
    await ensureCollection(db, vatReturns);
  },
});
