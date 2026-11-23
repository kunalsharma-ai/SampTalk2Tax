import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { vatSettings } from '../collections/vat-returns';

/** The UAE's VAT 201 (TAX-033): the registration names the emirate the business is established in. */
export default defineMigration({
  id: '20270305100000_vat_settings_region',
  async up(db) {
    await ensureCollection(db, vatSettings);
  },
});
