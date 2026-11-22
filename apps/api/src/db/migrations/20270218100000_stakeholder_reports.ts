import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { stakeholderReports } from '../collections/stakeholder-reports';

/** Executive and investor reports (RPT-022, RPT-023). */
export default defineMigration({
  id: '20270218100000_stakeholder_reports',
  async up(db) {
    await ensureCollection(db, stakeholderReports);
  },
});
