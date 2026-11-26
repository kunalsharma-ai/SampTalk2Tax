import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { apiInstances } from '../collections/api-instances';

/**
 * Horizontal scaling (PERF-008): the list of running API servers, and rate-limit windows shared
 * by every server (`_rate_windows`, the store's own, removed by TTL once their window is over).
 */
export default defineMigration({
  id: '20270318100000_horizontal_scaling',
  async up(db) {
    await ensureCollection(db, apiInstances);
    await db.collection('_rate_windows').createIndex({ expiresAt: 1 }, { name: 'expires', expireAfterSeconds: 0 });
  },
});
