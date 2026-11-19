import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Consolidation adjustments (GL-034): consolidation_adjustments, entries made in a group's consolidation only. */
export default defineMigration({
  id: '20270113100000_consolidation_adjustments',
  async up(db) {
    for (const info of mirrorModels(['ConsolidationAdjustment'])) await ensureCollection(db, info.def);
  },
});
