import { randomUUID } from 'node:crypto';
import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/**
 * The plans, which PostgreSQL's migration 20261112090000_plans_subscriptions used to seed. A
 * database copied from PostgreSQL already has them (same codes), so only missing codes are added.
 * The prices are the directive's proposed launch prices (not final, SUBS-010), edited in
 * Platform administration.
 */
const PLANS = [
  { code: 'STARTER', name: 'Starter', description: 'Bookkeeping, invoicing, banking, GST and reports for a small business.', prices: { INR: { monthly: '499', annual: '4990' }, USD: { monthly: '9', annual: '90' } }, limits: { members: 2, aiCreditsPerMonth: null, documentUploadsPerMonth: 100 }, features: [] as string[], sortOrder: 1 },
  { code: 'GROWTH', name: 'Growth', description: 'Adds the AI assistant and agents, and more people.', prices: { INR: { monthly: '1499', annual: '14990' }, USD: { monthly: '25', annual: '250' } }, limits: { members: 5, aiCreditsPerMonth: 300, documentUploadsPerMonth: 500 }, features: ['AI'], sortOrder: 2 },
  { code: 'PROFESSIONAL', name: 'Professional', description: 'Adds payroll and foreign currencies for a growing finance team.', prices: { INR: { monthly: '3499', annual: '34990' }, USD: { monthly: '59', annual: '590' } }, limits: { members: 15, aiCreditsPerMonth: 1500, documentUploadsPerMonth: 2000 }, features: ['AI', 'PAYROLL', 'MULTI_CURRENCY'], sortOrder: 3 },
  { code: 'ENTERPRISE', name: 'Enterprise', description: 'Every module, including group consolidation, without member limits.', prices: { INR: { monthly: '8999', annual: '89990' }, USD: { monthly: '149', annual: '1490' } }, limits: { members: null, aiCreditsPerMonth: 5000, documentUploadsPerMonth: null }, features: ['AI', 'PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'], sortOrder: 4 },
];

export default defineMigration({
  id: '20261220100000_plans',
  async up(db) {
    const [info] = mirrorModels(['Plan']);
    await ensureCollection(db, info!.def);
    const plans = db.collection(info!.def.name);
    for (const p of PLANS) {
      if (await plans.findOne({ code: p.code })) continue;
      const now = new Date();
      await plans.insertOne({ _id: randomUUID() as never, ...p, isActive: true, createdAt: now, updatedAt: now });
    }
  },
});
