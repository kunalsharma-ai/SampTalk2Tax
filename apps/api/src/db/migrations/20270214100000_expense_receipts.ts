import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { expenseReceipts } from '../collections/expense-receipts';
import { attachments } from '../collections/sales';

/** Receipts matched to bank lines (EXP-019); attachments may now belong to one (EXPENSE_RECEIPT). */
export default defineMigration({
  id: '20270214100000_expense_receipts',
  async up(db) {
    await ensureCollection(db, expenseReceipts);
    await ensureCollection(db, attachments);
  },
});
