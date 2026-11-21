import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { auditEvidenceRequests } from '../collections/audit-evidence';
import { attachments } from '../collections/sales';

/** Audit evidence requests (AUDIT-003); attachments may now belong to one (AUDIT_EVIDENCE). */
export default defineMigration({
  id: '20270208100000_audit_evidence',
  async up(db) {
    await ensureCollection(db, auditEvidenceRequests);
    await ensureCollection(db, attachments);
  },
});
