import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** The collection for customer portal links (AR-030); a link is found by its token hash, which is unique. */
export default defineMigration({
  id: '20261213100000_customer_portal',
  async up(db) {
    for (const info of mirrorModels(['CustomerPortalLink'])) await ensureCollection(db, info.def);
  },
});
