import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Collections for usage-based billing on contracts (AR-012): meters and the readings against them. */
export default defineMigration({
  id: '20261211100000_usage_billing',
  async up(db) {
    for (const info of mirrorModels(['ContractMeter', 'UsageRecord'])) await ensureCollection(db, info.def);
  },
});
