import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Requests for a missing receipt (EXP-021): finance asks the claimant for the receipt on a claim
 * that went in without one. Kept as a record; a request is answered when a receipt is attached.
 */
export interface ReceiptRequestDoc {
  id: string;
  orgId: string;
  claimId: string;
  claimantId: string;
  note: string | null;
  requestedById: string;
  requestedAt: Date;
  /** Whether the email to the claimant went; null when email is not set up. */
  emailed: boolean | null;
  emailError: string | null;
}

export const receiptRequests = defineCollection<ReceiptRequestDoc>({
  name: 'expense_receipt_requests',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'claimId', 'claimantId', 'requestedById', 'requestedAt'],
    properties: {
      claimId: { bsonType: 'string' },
      claimantId: { bsonType: 'string' },
      note: { bsonType: ['string', 'null'], maxLength: 500 },
      requestedAt: { bsonType: 'date' },
      emailed: { bsonType: ['bool', 'null'] },
      emailError: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [{ key: { orgId: 1, claimId: 1, requestedAt: -1 }, name: 'org_claim_time' }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A receipt request is kept as sent');
    },
    beforeDelete() {
      throw new GuardViolation('Receipt requests are kept as a record');
    },
  },
});
