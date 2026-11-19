import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Enterprise contracts (SUBS-023): enterprise_contracts, and the contract on a subscription. Existing ones have none. */
export default defineMigration({
  id: '20270112100000_enterprise_contracts',
  async up(db) {
    await db.collection('subscriptions').updateMany({ contractId: { $exists: false } }, { $set: { contractId: null } });
    for (const info of mirrorModels(['EnterpriseContract', 'Subscription'])) await ensureCollection(db, info.def);
  },
});
