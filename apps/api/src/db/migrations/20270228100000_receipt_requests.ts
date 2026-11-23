import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { receiptRequests } from '../collections/receipt-requests';

/** Requests for missing receipts (EXP-021). */
export default defineMigration({
  id: '20270228100000_receipt_requests',
  async up(db) {
    await ensureCollection(db, receiptRequests);
  },
});
