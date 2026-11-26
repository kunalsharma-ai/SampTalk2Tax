import { defineCollection } from '@talk2tax/document-db';

/**
 * Thousands of organisations (PERF-001): when each organisation is next due for a background job
 * that walks every organisation (the alert checks), so that a pass reads only the few that are
 * due, by index, instead of every organisation and every past run. One row per job and
 * organisation; a worker claims a row by moving its time on. Holds no organisation data.
 */
export interface OrgRotationDoc {
  id: string;
  job: string;
  orgId: string;
  nextAt: Date;
  lastAt: Date | null;
}

export const orgRotations = defineCollection<OrgRotationDoc>({
  name: 'org_rotations',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['job', 'orgId', 'nextAt', 'lastAt'],
    properties: {
      job: { bsonType: 'string', maxLength: 40 },
      orgId: { bsonType: 'string', maxLength: 64 },
      nextAt: { bsonType: 'date' },
      lastAt: { bsonType: ['date', 'null'] },
    },
  },
  indexes: [
    { key: { job: 1, nextAt: 1 }, name: 'due' },
    { key: { job: 1, orgId: 1 }, name: 'one_per_org', unique: true },
  ],
});
