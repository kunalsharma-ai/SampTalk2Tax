import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { costAllocationRules, costAllocationRuns } from '../collections/cost-allocations';

/** Cost allocation rules and their runs (GL-024). */
export default defineMigration({
  id: '20261229100000_cost_allocations',
  async up(db) {
    await ensureCollection(db, costAllocationRules);
    await ensureCollection(db, costAllocationRuns);
  },
});
