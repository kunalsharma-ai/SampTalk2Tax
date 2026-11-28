import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Demonstration organisations (DEMO-001): which made-up company profile an organisation was
 * built from, who asked for it, how far the build got and what it made. One per organisation;
 * the organisation itself is flagged isDemo and named "(SYNTHETIC DATA)". Kept as a record.
 */
export interface DemoOrganisationDoc {
  id: string;
  orgId: string;
  profile: string;
  status: 'BUILDING' | 'READY' | 'FAILED';
  /** What was posted, by kind (customers, invoices, journals...). */
  counts: Record<string, number>;
  failure: string | null;
  createdById: string;
  createdAt: Date;
  finishedAt: Date | null;
}

export const demoOrganisations = defineCollection<DemoOrganisationDoc>({
  name: 'demo_organisations',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'profile', 'status', 'counts', 'failure', 'createdById', 'createdAt', 'finishedAt'],
    properties: {
      profile: { bsonType: 'string', maxLength: 40 },
      status: { enum: ['BUILDING', 'READY', 'FAILED'] },
      counts: { bsonType: 'object' },
      failure: { bsonType: ['string', 'null'], maxLength: 500 },
      createdById: { bsonType: 'string', maxLength: 64 },
      createdAt: { bsonType: 'date' },
      finishedAt: { bsonType: ['date', 'null'] },
    },
  },
  indexes: [
    { key: { orgId: 1 }, name: 'one_per_org', unique: true },
    { key: { createdById: 1 }, name: 'by_person' },
  ],
  guards: {
    beforeInsert(d) {
      if (d.status !== 'BUILDING') throw new GuardViolation('A demonstration organisation starts building');
    },
    afterUpdate(before, after) {
      if (before.profile !== after.profile || before.createdById !== after.createdById || before.orgId !== after.orgId)
        throw new GuardViolation('A demonstration organisation keeps its profile and who asked for it');
      if (before.status !== 'BUILDING') throw new GuardViolation('A finished build is kept as it was');
    },
    beforeDelete() {
      throw new GuardViolation('Demonstration organisation records are kept');
    },
  },
});
