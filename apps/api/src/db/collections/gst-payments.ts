import { defineCollection } from '@talk2tax/document-db';

type Heads = { igst: string; cgst: string; sgst: string };

/**
 * GST payments (TAX-022): one settlement of a return month. Input tax credit is set off against
 * the tax payable in the order the CGST Act requires and the rest is paid in cash through a
 * PMT-06 challan; one journal records both. Voiding reverses the journal.
 */
export interface GstPaymentDoc {
  id: string;
  orgId: string;
  /** GSTP-000001. */
  number: string;
  /** The return month, YYYY-MM. */
  period: string;
  paymentDate: Date;
  /** Tax payable and credit available as at the end of the month, before this payment. */
  liability: Heads;
  credit: Heads;
  /** Each use of credit: from which head of credit, against which head of tax. */
  uses: { from: 'igst' | 'cgst' | 'sgst'; against: 'igst' | 'cgst' | 'sgst'; amount: string }[];
  creditUsed: Heads;
  cash: Heads;
  interest: string;
  lateFee: string;
  /** Expense account interest and late fee are charged to; null when there are none. */
  chargesAccountId: string | null;
  /** Bank account the cash came from; null when credit covered everything. */
  bankAccountId: string | null;
  /** The challan's CPIN (14 characters) and the bank's CIN, when cash was paid. */
  cpin: string | null;
  cin: string | null;
  memo: string | null;
  journalEntryId: string;
  status: 'POSTED' | 'VOID';
  voidReason: string | null;
  reversalEntryId: string | null;
  createdById: string;
  createdAt: Date;
  voidedById: string | null;
  voidedAt: Date | null;
}

const heads = ['liability', 'credit', 'creditUsed', 'cash'].flatMap((k) => ['igst', 'cgst', 'sgst'].map((h) => `${k}.${h}`));

export const gstPayments = defineCollection<GstPaymentDoc>({
  name: 'gst_payments',
  scope: 'tenant',
  decimals: [...heads, 'uses[].amount', 'interest', 'lateFee'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'period', 'paymentDate', 'liability', 'credit', 'uses', 'creditUsed', 'cash', 'interest', 'lateFee', 'chargesAccountId', 'bankAccountId', 'cpin', 'cin', 'memo', 'journalEntryId', 'status', 'voidReason', 'reversalEntryId', 'createdById', 'createdAt', 'voidedById', 'voidedAt'],
    properties: {
      number: { bsonType: 'string', pattern: '^GSTP-[0-9]{6}$' },
      period: { bsonType: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
      paymentDate: { bsonType: 'date' },
      uses: { bsonType: 'array', maxItems: 9 },
      status: { enum: ['POSTED', 'VOID'] },
      cpin: { bsonType: ['string', 'null'], maxLength: 14 },
      cin: { bsonType: ['string', 'null'], maxLength: 30 },
      memo: { bsonType: ['string', 'null'], maxLength: 500 },
      voidReason: { bsonType: ['string', 'null'], maxLength: 500 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'org_number', unique: true },
    { key: { orgId: 1, period: 1, status: 1 }, name: 'org_period' },
  ],
});
