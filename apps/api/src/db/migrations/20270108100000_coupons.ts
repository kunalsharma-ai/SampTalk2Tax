import { Decimal128, defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * Coupons on subscriptions (SUBS-024): coupons and coupon_redemptions, and the coupon fields on
 * subscriptions and subscription_invoices. Existing ones get no coupon and no discount, and the
 * validators gain the decimal discount.
 */
export default defineMigration({
  id: '20270108100000_coupons',
  async up(db) {
    await db.collection('subscription_invoices').updateMany({ discount: { $exists: false } }, { $set: { discount: Decimal128.fromString('0'), couponId: null, couponCode: null } });
    await db.collection('subscriptions').updateMany({ couponUses: { $exists: false } }, { $set: { couponUses: 0, couponId: null } });
    for (const info of mirrorModels(['Coupon', 'CouponRedemption', 'Subscription', 'SubscriptionInvoice'])) await ensureCollection(db, info.def);
  },
});
