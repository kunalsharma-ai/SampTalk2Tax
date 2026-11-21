import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { sodReviews } from '../collections/sod-reviews';

/** Segregation-of-duties reviews (AUDIT-014). */
export default defineMigration({
  id: '20270201100000_sod_reviews',
  async up(db) {
    await ensureCollection(db, sodReviews);
  },
});
