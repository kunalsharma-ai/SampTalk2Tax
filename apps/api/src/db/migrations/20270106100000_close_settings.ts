import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** How the month-end close starts (WFLOW-021): close_settings, one per organisation. */
export default defineMigration({
  id: '20270106100000_close_settings',
  async up(db) {
    for (const info of mirrorModels(['CloseSettings'])) await ensureCollection(db, info.def);
  },
});
