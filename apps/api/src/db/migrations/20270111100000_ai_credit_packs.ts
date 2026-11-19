import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * Extra AI requests (SUBS-018): ai_credit_packs and ai_credit_grants, the pack on a CREDITS
 * subscription invoice, and the grant an AI request beyond the plan came from. Existing
 * invoices bought no pack, and existing AI requests were all the plan's.
 */
export default defineMigration({
  id: '20270111100000_ai_credit_packs',
  async up(db) {
    await db.collection('subscription_invoices').updateMany({ creditPack: { $exists: false } }, { $set: { creditPack: null } });
    await db.collection('usage_events').updateMany({ creditGrantId: { $exists: false } }, { $set: { creditGrantId: null } });
    for (const info of mirrorModels(['AiCreditPack', 'AiCreditGrant', 'SubscriptionInvoice', 'UsageEvent'])) await ensureCollection(db, info.def);
  },
});
