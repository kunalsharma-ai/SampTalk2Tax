import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { allocations, contacts, documents, payments } from '../collections/sales';

/** Sales and purchases move from PostgreSQL: contacts, and invoices, bills and credits with their lines, and the receipts, payments and credits that settle them. */
export default defineMigration({
  id: '20261110090000_sales',
  async up(db) {
    await ensureCollection(db, contacts);
    await ensureCollection(db, documents);
    await ensureCollection(db, payments);
    await ensureCollection(db, allocations);
  },
});
