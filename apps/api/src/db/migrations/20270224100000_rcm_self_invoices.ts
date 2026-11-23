import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { rcmSelfInvoices } from '../collections/rcm-self-invoices';

/** Reverse-charge self-invoices (TAX-032). */
export default defineMigration({
  id: '20270224100000_rcm_self_invoices',
  async up(db) {
    await ensureCollection(db, rcmSelfInvoices);
  },
});
