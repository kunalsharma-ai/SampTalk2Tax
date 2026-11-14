import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { authSessions, loginThrottles, users } from '../collections/identity';

/** Users, sign-in sessions and failed sign-in counters move from PostgreSQL. */
export default defineMigration({
  id: '20261109100000_identity',
  async up(db) {
    for (const def of [users, authSessions, loginThrottles]) await ensureCollection(db, def);
  },
});
