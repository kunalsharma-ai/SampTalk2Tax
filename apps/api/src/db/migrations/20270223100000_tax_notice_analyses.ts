import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxNoticeAnalyses } from '../collections/tax-notice-analyses';

/** Tax notice analyses (TAX-050). */
export default defineMigration({
  id: '20270223100000_tax_notice_analyses',
  async up(db) {
    await ensureCollection(db, taxNoticeAnalyses);
  },
});
