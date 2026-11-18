import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { depositEvents, deposits } from '../collections/deposits';

/** Term deposits and their postings (BANK-011). */
export default defineMigration({
  id: '20270103100000_deposits',
  async up(db) {
    await ensureCollection(db, deposits);
    await ensureCollection(db, depositEvents);
  },
});
