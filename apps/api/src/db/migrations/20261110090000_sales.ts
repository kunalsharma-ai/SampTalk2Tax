import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { bankMatches, bankReconciliations, bankStatementImports, bankStatementLines } from '../collections/banking';
import { expenseClaims } from '../collections/expenses';
import { allocations, approvalPolicies, approvalRequests, attachments, contacts, documents, payments } from '../collections/sales';

/**
 * Sales and purchases move from PostgreSQL: contacts; invoices, bills and credits with their
 * lines; the receipts, payments and credits that settle them; approvals; attachments; expense
 * claims; and bank statements, matching and reconciliation.
 */
export default defineMigration({
  id: '20261110090000_sales',
  async up(db) {
    for (const def of [contacts, documents, payments, allocations, approvalPolicies, approvalRequests, attachments, expenseClaims, bankStatementImports, bankStatementLines, bankMatches, bankReconciliations]) {
      await ensureCollection(db, def);
    }
  },
});
