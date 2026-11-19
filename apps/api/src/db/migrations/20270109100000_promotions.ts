import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Promotional pricing (SUBS-025): coupons gain autoApply; existing coupons need a code. */
export default defineMigration({
  id: '20270109100000_promotions',
  async up(db) {
    await db.collection('coupons').updateMany({ autoApply: { $exists: false } }, { $set: { autoApply: false } });
    for (const info of mirrorModels(['Coupon'])) await ensureCollection(db, info.def);
  },
});
