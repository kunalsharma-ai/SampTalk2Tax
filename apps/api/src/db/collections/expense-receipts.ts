import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Receipts for spending paid from a company bank or card account (EXP-019): what the receipt says
 * (merchant, date, amount), the file (an attachment with entity EXPENSE_RECEIPT), and the bank
 * statement line it was matched to. What the receipt says never changes; a match can be undone,
 * a discarded receipt stays discarded, and history is only added to.
 */
export interface ExpenseReceiptDoc {
  id: string;
  orgId: string;
  number: number;
  merchant: string;
  /** YYYY-MM-DD, the date on the receipt. */
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  status: 'UNMATCHED' | 'MATCHED' | 'DISCARDED';
  statementLineId: string | null;
  matchedById: string | null;
  matchedAt: Date | null;
  history: { at: Date; byId: string; action: string; note: string }[];
  createdById: string;
  createdAt: Date;
}

const FIXED = ['number', 'merchant', 'date', 'amount', 'currency', 'note', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const expenseReceipts = defineCollection<ExpenseReceiptDoc>({
  name: 'expense_receipts',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'merchant', 'date', 'amount', 'currency', 'status', 'history', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      merchant: { bsonType: 'string', minLength: 1, maxLength: 200 },
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      amount: { bsonType: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' },
      currency: { bsonType: 'string', minLength: 3, maxLength: 3 },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
      status: { enum: ['UNMATCHED', 'MATCHED', 'DISCARDED'] },
      statementLineId: { bsonType: ['string', 'null'] },
      history: { bsonType: 'array' },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, status: 1, date: 1 }, name: 'by_status' },
    { key: { orgId: 1, createdById: 1 }, name: 'by_person' },
    { key: { orgId: 1, statementLineId: 1 }, name: 'one_receipt_per_line', unique: true, partialFilterExpression: { statementLineId: { $type: 'string' } } },
  ],
  guards: {
    beforeInsert(r) {
      if (r.status !== 'UNMATCHED' || r.statementLineId !== null) throw new GuardViolation('A receipt starts unmatched');
    },
    afterUpdate(before, after) {
      if (before.status === 'DISCARDED') throw new GuardViolation('A discarded receipt stays discarded');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('What a receipt says cannot be changed');
      if (after.history.length < before.history.length || !before.history.every((h, i) => same(h, after.history[i]))) throw new GuardViolation('Receipt history is only added to');
      if ((after.status === 'MATCHED') !== (after.statementLineId !== null)) throw new GuardViolation('A matched receipt has a bank line, and only a matched one');
    },
    beforeDelete() {
      throw new GuardViolation('Receipts are kept as a record');
    },
  },
});
