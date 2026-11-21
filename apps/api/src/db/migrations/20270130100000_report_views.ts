import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { reportViews } from '../collections/report-views';

/** Saved report views (RPT-028, RPT-029, RPT-037). */
export default defineMigration({
  id: '20270130100000_report_views',
  async up(db) {
    await ensureCollection(db, reportViews);
  },
});
