import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { journalEntries } from '../collections/ledger';

/** Journal entries (with their lines) move from PostgreSQL. */
export default defineMigration({
  id: '20261109130000_ledger',
  async up(db) {
    await ensureCollection(db, journalEntries);
  },
});
