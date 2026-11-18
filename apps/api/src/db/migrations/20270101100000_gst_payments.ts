import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { gstPayments } from '../collections/gst-payments';

/** GST payments and set-off (TAX-022). */
export default defineMigration({
  id: '20270101100000_gst_payments',
  async up(db) {
    await ensureCollection(db, gstPayments);
  },
});
