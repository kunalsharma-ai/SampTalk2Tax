import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Unbilled revenue dismissals (AR-042) kept in step with PostgreSQL. */
export default defineMigration({
  id: '20261216100000_unbilled_revenue',
  async up(db) {
    for (const info of mirrorModels(['UnbilledRevenueDismissal'])) await ensureCollection(db, info.def);
  },
});
