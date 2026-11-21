import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { auditEngagements } from '../collections/audit-engagements';

/** Internal audit engagements (AUDIT-001). */
export default defineMigration({
  id: '20270207100000_audit_engagements',
  async up(db) {
    await ensureCollection(db, auditEngagements);
  },
});
