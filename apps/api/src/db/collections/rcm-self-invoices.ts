import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Reverse-charge self-invoices (TAX-032): the invoice a buyer issues for a bill under reverse charge
 * from a supplier who is not registered (CGST Act s.31(3)(f), rule 47A). One per bill, numbered
 * RCM/<financial year>/<seq> in one series per year. Never changed or deleted.
 */
export interface RcmSelfInvoiceDoc {
  id: string;
  orgId: string;
  documentId: string;
  /** RCM/2026-27/0001. */
  number: string;
  /** Financial year, e.g. 2026-27. */
  fy: string;
  seq: number;
  /** YYYY-MM-DD. */
  issuedOn: string;
  createdById: string;
  createdAt: Date;
}

export const rcmSelfInvoices = defineCollection<RcmSelfInvoiceDoc>({
  name: 'rcm_self_invoices',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'documentId', 'number', 'fy', 'seq', 'issuedOn', 'createdById', 'createdAt'],
    properties: {
      documentId: { bsonType: 'string' },
      number: { bsonType: 'string', pattern: '^RCM/\\d{4}-\\d{2}/\\d{4,}$' },
      fy: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}$' },
      seq: { bsonType: ['int', 'long', 'double'], minimum: 1 },
      issuedOn: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  },
  indexes: [
    { key: { orgId: 1, documentId: 1 }, name: 'one_self_invoice_a_bill', unique: true },
    { key: { orgId: 1, number: 1 }, name: 'self_invoice_number', unique: true },
    { key: { orgId: 1, fy: 1, seq: -1 }, name: 'self_invoice_series' },
  ],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A self-invoice cannot be changed once issued');
    },
    beforeDelete() {
      throw new GuardViolation('Self-invoices are kept');
    },
  },
});
