import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { auditSamples } from '../collections/audit-samples';

/** Audit samples (AUDIT-009). */
export default defineMigration({
  id: '20270204100000_audit_samples',
  async up(db) {
    await ensureCollection(db, auditSamples);
  },
});
