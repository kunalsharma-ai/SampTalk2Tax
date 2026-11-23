import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { bankFeedConnections, bankFeedDeliveries } from '../collections/bank-feeds';

/** Bank feed connections and their deliveries (BANK-004). */
export default defineMigration({
  id: '20270226100000_bank_feeds',
  async up(db) {
    await ensureCollection(db, bankFeedConnections);
    await ensureCollection(db, bankFeedDeliveries);
  },
});
