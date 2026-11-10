import { defineMigration } from '@talk2tax/document-db';

/** Lock documents that transactions write to take turns on a record or a name (db/locks.ts). */
export default defineMigration({
  id: '20261218100000_row_locks',
  async up(db) {
    const existing = await db.listCollections({ name: '_row_locks' }, { nameOnly: true }).toArray();
    if (!existing.length) await db.createCollection('_row_locks');
  },
});
