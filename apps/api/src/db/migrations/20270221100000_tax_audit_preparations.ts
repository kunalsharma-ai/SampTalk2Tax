import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { taxAuditPreparations } from '../collections/tax-audit-preparations';

/** Tax audit preparations (TAX-051). */
export default defineMigration({
  id: '20270221100000_tax_audit_preparations',
  async up(db) {
    await ensureCollection(db, taxAuditPreparations);
  },
});
