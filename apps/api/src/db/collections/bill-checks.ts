import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Reviews of unusual bill checks (AP-031): someone looked at a bill's findings and said why it is
 * fine. A review covers the findings it saw (their fingerprint); a new finding needs a new review.
 * Reviews are kept as written.
 */
export interface BillCheckReviewDoc {
  id: string;
  orgId: string;
  documentId: string;
  fingerprint: string;
  note: string;
  reviewedById: string;
  reviewedAt: Date;
}

export const billCheckReviews = defineCollection<BillCheckReviewDoc>({
  name: 'bill_check_reviews',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'documentId', 'fingerprint', 'note', 'reviewedById', 'reviewedAt'],
    properties: {
      fingerprint: { bsonType: 'string', minLength: 1 },
      note: { bsonType: 'string', minLength: 3, maxLength: 1000 },
      reviewedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, documentId: 1, reviewedAt: -1 }, name: 'org_document_reviewed' }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A bill check review is kept as written');
    },
    beforeDelete() {
      throw new GuardViolation('A bill check review is kept as written');
    },
  },
});
