import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { contacts } from '../collections/sales';

/** Cross-border tax reporting (TAX-038): contacts carry an optional ISO country code. */
export default defineMigration({
  id: '20270310100000_contact_country',
  async up(db) {
    await ensureCollection(db, contacts);
  },
});
