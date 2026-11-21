import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Organisation setup (UX-004 to UX-006, UX-017, UX-019): the business profile from onboarding
 * and when the organisation was activated. One per organisation; activation is recorded once.
 */
export interface OrgSetupDoc {
  id: string;
  orgId: string;
  industry: string | null;
  size: string | null;
  framework: string | null;
  aiPreference: string | null;
  activatedAt: Date | null;
  activatedById: string | null;
  /** The last reading by the onboarding assistant (UX-020 to UX-022), with each recommendation's decision. */
  assistant?: AssistantReadingDoc | null;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AssistantRecommendationDoc {
  id: string;
  kind: 'PROFILE' | 'STEP' | 'NOTE';
  field: string | null;
  value: string | null;
  title: string;
  reason: string;
  link: string | null;
  status: 'PENDING' | 'ACCEPTED' | 'DISMISSED';
  decidedById: string | null;
  decidedAt: Date | null;
}

export interface AssistantReadingDoc {
  description: string;
  source: 'AI' | 'RULES';
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** AI findings left out because they were off the lists or quoted words the owner did not write. */
  dropped: string[];
  recommendations: AssistantRecommendationDoc[];
  readById: string;
  readAt: Date;
}

export const orgSetup = defineCollection<OrgSetupDoc>({
  name: 'org_setup',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'industry', 'size', 'framework', 'aiPreference', 'activatedAt', 'activatedById', 'updatedById', 'createdAt', 'updatedAt'],
    properties: {
      industry: { bsonType: ['string', 'null'], maxLength: 40 },
      size: { bsonType: ['string', 'null'], maxLength: 20 },
      framework: { bsonType: ['string', 'null'], maxLength: 20 },
      aiPreference: { enum: ['OFF', 'ADVISE', 'PREPARE', null] },
      activatedAt: { bsonType: ['date', 'null'] },
      activatedById: { bsonType: ['string', 'null'] },
      assistant: {
        bsonType: ['object', 'null'],
        required: ['description', 'source', 'recommendations', 'readById', 'readAt'],
        properties: {
          description: { bsonType: 'string', maxLength: 2000 },
          source: { enum: ['AI', 'RULES'] },
          recommendations: { bsonType: 'array', maxItems: 40, items: { bsonType: 'object', required: ['id', 'kind', 'status'], properties: { status: { enum: ['PENDING', 'ACCEPTED', 'DISMISSED'] } } } },
          readAt: { bsonType: 'date' },
        },
      },
    },
  },
  indexes: [{ key: { orgId: 1 }, name: 'one_per_org', unique: true }],
  guards: {
    afterUpdate(before, after) {
      if (before.activatedAt && (after.activatedAt?.getTime() !== before.activatedAt.getTime() || after.activatedById !== before.activatedById)) {
        throw new GuardViolation('An activation is kept as it was recorded');
      }
      if (before.activatedAt && JSON.stringify(before.assistant ?? null) !== JSON.stringify(after.assistant ?? null)) {
        throw new GuardViolation('The setup assistant is closed once the organisation is active');
      }
      if (!!after.activatedAt !== !!after.activatedById) throw new GuardViolation('An activation records who activated the organisation');
    },
    beforeDelete() {
      throw new GuardViolation('The setup record is kept with the organisation');
    },
  },
});
