import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { auditorPortalLinks } from '../collections/auditor-portal';

/** External auditor portal links (AUDIT-002). */
export default defineMigration({
  id: '20270209100000_auditor_portal',
  async up(db) {
    await ensureCollection(db, auditorPortalLinks);
  },
});
