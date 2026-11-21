import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Internal controls register (AUDIT-008, AUDIT-013): the organisation's controls, each with an
 * owner and a frequency, and the tests recorded against them.
 */
export interface InternalControlDoc {
  id: string;
  orgId: string;
  title: string;
  objective: string;
  area: string;
  frequency: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** An automatic check the server runs for a period, or null for a control tested by hand. */
  check: string | null;
  /** The library control it was added from, if any. */
  templateId: string | null;
  ownerId: string;
  active: boolean;
  createdById: string;
  createdAt: Date;
  updatedById: string;
  updatedAt: Date;
}

export const internalControls = defineCollection<InternalControlDoc>({
  name: 'internal_controls',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'title', 'objective', 'area', 'frequency', 'ownerId', 'active', 'createdById', 'createdAt', 'updatedById', 'updatedAt'],
    properties: {
      title: { bsonType: 'string', minLength: 1, maxLength: 120 },
      objective: { bsonType: 'string', maxLength: 500 },
      area: { bsonType: 'string', maxLength: 20 },
      frequency: { enum: ['MONTHLY', 'QUARTERLY', 'YEARLY'] },
      ownerId: { bsonType: 'string' },
      active: { bsonType: 'bool' },
    },
  },
  indexes: [{ key: { orgId: 1, title: 1 }, name: 'one_title', unique: true }],
});

/** One test of a control for one period. Kept as recorded: a later test is a new record. */
export interface ControlTestDoc {
  id: string;
  orgId: string;
  controlId: string;
  periodKey: string;
  from: Date;
  to: Date;
  result: 'PASS' | 'FAIL';
  method: 'AUTOMATIC' | 'MANUAL';
  notes: string | null;
  /** For an automatic check: what the server looked at and each exception it found. */
  evidence: { summary: string; exceptions: string[] } | null;
  /** The owner tested their own control because no one else could. */
  selfTested: boolean;
  testedById: string;
  testedAt: Date;
}

export const controlTests = defineCollection<ControlTestDoc>({
  name: 'control_tests',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'controlId', 'periodKey', 'from', 'to', 'result', 'method', 'selfTested', 'testedById', 'testedAt'],
    properties: {
      controlId: { bsonType: 'string' },
      periodKey: { bsonType: 'string', maxLength: 10 },
      result: { enum: ['PASS', 'FAIL'] },
      method: { enum: ['AUTOMATIC', 'MANUAL'] },
      selfTested: { bsonType: 'bool' },
      testedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, controlId: 1, periodKey: 1, testedAt: -1 }, name: 'by_control_period' }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A control test is kept as it was recorded');
    },
    beforeDelete() {
      throw new GuardViolation('Control tests are kept as a record');
    },
  },
});
