import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { reportFavourites } from '../collections/report-favourites';

/** Reports people pin in the reporting studio (RPT-001). */
export default defineMigration({
  id: '20270309100000_report_favourites',
  async up(db) {
    await ensureCollection(db, reportFavourites);
  },
});
