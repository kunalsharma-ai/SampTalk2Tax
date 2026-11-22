import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { complianceDocuments } from '../collections/compliance-documents';
import { attachments } from '../collections/sales';

/** Compliance documents (TAX-025); attachments may now belong to one (COMPLIANCE_DOCUMENT). */
export default defineMigration({
  id: '20270215100000_compliance_documents',
  async up(db) {
    await ensureCollection(db, complianceDocuments);
    await ensureCollection(db, attachments);
  },
});
