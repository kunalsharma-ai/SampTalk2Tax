import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { billCheckReviews } from '../collections/bill-checks';

/** Reviews of unusual bill checks. */
export default defineMigration({
  id: '20261226100000_bill_checks',
  async up(db) {
    await ensureCollection(db, billCheckReviews);
  },
});
