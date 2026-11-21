import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { auditFindings } from '../collections/audit-findings';

/** Audit findings and remediation (AUDIT-011, AUDIT-012). */
export default defineMigration({
  id: '20270203100000_audit_findings',
  async up(db) {
    await ensureCollection(db, auditFindings);
  },
});
