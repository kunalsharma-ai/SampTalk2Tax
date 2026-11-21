import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { paymentPlans } from '../collections/payment-plans';

/** Agreed customer payment plans (AR-040). */
export default defineMigration({
  id: '20270210100000_payment_plans',
  async up(db) {
    await ensureCollection(db, paymentPlans);
  },
});
