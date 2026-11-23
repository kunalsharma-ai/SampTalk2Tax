import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vatReturns, vatSettings } from '../collections/vat-returns';

/** VAT and GST returns for more countries (TAX-036 Singapore): registration numbers and boxes beyond the UK's. */
export default defineMigration({
  id: '20270302100000_vat_returns_countries',
  async up(db) {
    await ensureCollection(db, vatSettings);
    await ensureCollection(db, vatReturns);
  },
});
