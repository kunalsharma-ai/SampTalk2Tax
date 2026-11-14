import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { invitations, memberships, organizations } from '../collections/tenancy';

/** Organisations, memberships and invitations move from PostgreSQL. */
export default defineMigration({
  id: '20261109110000_tenancy',
  async up(db) {
    for (const def of [organizations, memberships, invitations]) await ensureCollection(db, def);
  },
});
