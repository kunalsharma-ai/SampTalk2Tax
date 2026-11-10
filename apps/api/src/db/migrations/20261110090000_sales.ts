import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { contacts } from '../collections/sales';

/** Sales and purchases move from PostgreSQL: contacts first. */
export default defineMigration({
  id: '20261110090000_sales',
  async up(db) {
    await ensureCollection(db, contacts);
  },
});
