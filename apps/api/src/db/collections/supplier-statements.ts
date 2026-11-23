import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Supplier statements (AP-011): a statement of account a supplier sent for a period, entered or
 * pasted line by line, to reconcile against the bills, vendor credits and payments in the books.
 * The reconciliation itself is worked out each time it is read. Editable while OPEN; once marked
 * RECONCILED it is fixed. Never deleted.
 */
export interface SupplierStatementLineDoc {
  date: string;
  reference: string;
  kind: 'INVOICE' | 'DEBIT_NOTE' | 'CREDIT_NOTE' | 'PAYMENT';
  amount: string;
  description: string | null;
}

export interface SupplierStatementDoc {
  id: string;
  orgId: string;
  contactId: string;
  currency: string;
  /** The period the statement covers, YYYY-MM-DD. */
  from: string;
  to: string;
  theirOpening: string;
  theirClosing: string;
  lines: SupplierStatementLineDoc[];
  status: 'OPEN' | 'RECONCILED';
  note: string | null;
  reconciledById: string | null;
  reconciledAt: Date | null;
  createdById: string;
  createdAt: Date;
  updatedById: string;
  updatedAt: Date;
}

export const supplierStatements = defineCollection<SupplierStatementDoc>({
  name: 'supplier_statements',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'contactId', 'currency', 'from', 'to', 'theirOpening', 'theirClosing', 'lines', 'status', 'createdById', 'createdAt', 'updatedById', 'updatedAt'],
    properties: {
      contactId: { bsonType: 'string' },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      from: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      to: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      theirOpening: { bsonType: 'string', pattern: '^-?\\d+(\\.\\d{1,2})?$' },
      theirClosing: { bsonType: 'string', pattern: '^-?\\d+(\\.\\d{1,2})?$' },
      lines: {
        bsonType: 'array',
        maxItems: 500,
        items: {
          bsonType: 'object',
          required: ['date', 'reference', 'kind', 'amount'],
          properties: {
            date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            reference: { bsonType: 'string', maxLength: 60 },
            kind: { enum: ['INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE', 'PAYMENT'] },
            amount: { bsonType: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
          },
        },
      },
      status: { enum: ['OPEN', 'RECONCILED'] },
    },
  },
  indexes: [{ key: { orgId: 1, contactId: 1, to: -1 }, name: 'statements_by_supplier' }],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'RECONCILED') throw new GuardViolation('A reconciled statement cannot be changed');
      if (before.contactId !== after.contactId || before.currency !== after.currency) throw new GuardViolation('A statement stays with its supplier and currency');
    },
    beforeDelete() {
      throw new GuardViolation('Supplier statements are kept');
    },
  },
});
