import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Segregation-of-duties reviews (AUDIT-014): a finding cleared by someone who was not involved,
 * with their reason. A review is a record, so it is never changed or deleted.
 */
export interface SodReviewDoc {
  id: string;
  orgId: string;
  /** The finding's stable key, such as SELF_POSTED_JOURNAL:<journal id>. */
  findingKey: string;
  rule: string;
  /** The people who did both jobs, as the finding named them when it was reviewed. */
  people: string[];
  reason: string;
  reviewedById: string;
  reviewedAt: Date;
}

export const sodReviews = defineCollection<SodReviewDoc>({
  name: 'sod_reviews',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'findingKey', 'rule', 'people', 'reason', 'reviewedById', 'reviewedAt'],
    properties: {
      findingKey: { bsonType: 'string', maxLength: 120 },
      rule: { bsonType: 'string', maxLength: 40 },
      people: { bsonType: 'array', items: { bsonType: 'string' } },
      reason: { bsonType: 'string', minLength: 10, maxLength: 500 },
      reviewedById: { bsonType: 'string' },
      reviewedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, findingKey: 1 }, name: 'one_review_per_finding', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A segregation-of-duties review is kept as it was made');
    },
    beforeDelete() {
      throw new GuardViolation('Segregation-of-duties reviews are kept as a record');
    },
  },
});
