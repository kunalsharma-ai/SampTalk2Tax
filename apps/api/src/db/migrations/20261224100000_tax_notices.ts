import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxNoticeFiles, taxNotices } from '../collections/tax-notices';

/** Tax notices and their files. */
export default defineMigration({
  id: '20261224100000_tax_notices',
  async up(db) {
    for (const def of [taxNotices, taxNoticeFiles]) await ensureCollection(db, def);
  },
});
