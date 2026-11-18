import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { journalApprovalPolicies, journalApprovals } from '../collections/journal-approvals';

/** Approval of manual journals above an amount (SEC-036). */
export default defineMigration({
  id: '20261230100000_journal_approvals',
  async up(db) {
    await ensureCollection(db, journalApprovalPolicies);
    await ensureCollection(db, journalApprovals);
  },
});
