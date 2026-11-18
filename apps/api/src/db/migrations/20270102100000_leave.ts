import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { leaveEntries, leaveTypes } from '../collections/leave';

/** Leave types and leave taken (PAY-011). */
export default defineMigration({
  id: '20270102100000_leave',
  async up(db) {
    await ensureCollection(db, leaveTypes);
    await ensureCollection(db, leaveEntries);
  },
});
