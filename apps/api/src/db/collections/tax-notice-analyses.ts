import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Tax notice analyses (TAX-050): for one notice, the notice type the user chose (when the section
 * does not identify it) and which items of its checklist are done. The analysis itself is worked
 * out from the notice each time it is read. One per notice; never deleted.
 */
export interface TaxNoticeAnalysisDoc {
  id: string;
  orgId: string;
  noticeId: string;
  chosenType: string | null;
  checked: string[];
  updatedById: string;
  updatedAt: Date;
  createdAt: Date;
}

export const taxNoticeAnalyses = defineCollection<TaxNoticeAnalysisDoc>({
  name: 'tax_notice_analyses',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'noticeId', 'checked', 'updatedById', 'updatedAt', 'createdAt'],
    properties: {
      noticeId: { bsonType: 'string' },
      chosenType: { bsonType: ['string', 'null'], pattern: '^[A-Z0-9_]{2,40}$' },
      checked: { bsonType: 'array', maxItems: 20, items: { bsonType: 'string', pattern: '^[a-z0-9_]{1,40}$' } },
    },
  },
  indexes: [{ key: { orgId: 1, noticeId: 1 }, name: 'one_analysis_a_notice', unique: true }],
  guards: {
    afterUpdate(before, after) {
      if (before.noticeId !== after.noticeId) throw new GuardViolation('An analysis stays with its notice');
    },
    beforeDelete() {
      throw new GuardViolation('Notice analyses are kept with the notice');
    },
  },
});
