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
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
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
    },
  },
  indexes: [{ key: { orgId: 1 }, name: 'one_per_org', unique: true }],
  guards: {
    afterUpdate(before, after) {
      if (before.activatedAt && (after.activatedAt?.getTime() !== before.activatedAt.getTime() || after.activatedById !== before.activatedById)) {
        throw new GuardViolation('An activation is kept as it was recorded');
      }
      if (!!after.activatedAt !== !!after.activatedById) throw new GuardViolation('An activation records who activated the organisation');
    },
    beforeDelete() {
      throw new GuardViolation('The setup record is kept with the organisation');
    },
  },
});
