import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * Add-on modules (SUBS-017): add_on_prices, and add-ons on subscriptions and subscription
 * invoices. Existing ones have none.
 */
export default defineMigration({
  id: '20270110100000_add_ons',
  async up(db) {
    await db.collection('subscriptions').updateMany({ addOns: { $exists: false } }, { $set: { addOns: [], requestedAddOns: [] } });
    await db.collection('subscription_invoices').updateMany({ addOns: { $exists: false } }, { $set: { addOns: [], addOnLines: [] } });
    for (const info of mirrorModels(['AddOnPrice', 'Subscription', 'SubscriptionInvoice'])) await ensureCollection(db, info.def);
  },
});
