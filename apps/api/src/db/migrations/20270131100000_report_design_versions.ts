import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { reportDesignVersions } from '../collections/report-design-versions';

/** Report design version history (RPT-039). */
export default defineMigration({
  id: '20270131100000_report_design_versions',
  async up(db) {
    await ensureCollection(db, reportDesignVersions);
  },
});
