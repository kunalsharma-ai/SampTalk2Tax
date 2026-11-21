import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Audit findings and remediation (AUDIT-011, AUDIT-012): a problem to fix, with its remediation
 * owner, plan and due date, and every update kept in order. A closed finding is kept as it was
 * closed.
 */
export interface FindingUpdate {
  at: Date;
  byId: string;
  status: string;
  note: string;
}

export interface AuditFindingDoc {
  id: string;
  orgId: string;
  number: number;
  title: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  source: 'CONTROL_TEST' | 'MANUAL';
  /** For a finding raised from a failed control test. */
  controlId: string | null;
  testId: string | null;
  testPeriodKey: string | null;
  ownerId: string;
  plan: string;
  dueDate: Date;
  status: 'OPEN' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'CLOSED';
  updates: FindingUpdate[];
  raisedById: string;
  raisedAt: Date;
  closedById: string | null;
  closedAt: Date | null;
  /** The passing test that cleared a finding raised from a control test. */
  clearedByTestId: string | null;
}

export const auditFindings = defineCollection<AuditFindingDoc>({
  name: 'audit_findings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'title', 'description', 'severity', 'source', 'ownerId', 'plan', 'dueDate', 'status', 'updates', 'raisedById', 'raisedAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      title: { bsonType: 'string', minLength: 1, maxLength: 140 },
      description: { bsonType: 'string', maxLength: 2000 },
      severity: { enum: ['LOW', 'MEDIUM', 'HIGH'] },
      source: { enum: ['CONTROL_TEST', 'MANUAL'] },
      plan: { bsonType: 'string', maxLength: 2000 },
      status: { enum: ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CLOSED'] },
      updates: { bsonType: 'array' },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, testId: 1 }, name: 'one_per_test', unique: true, partialFilterExpression: { testId: { $type: 'string' } } },
    { key: { orgId: 1, status: 1 }, name: 'by_status' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'CLOSED') throw new GuardViolation('A closed finding is kept as it was closed');
      if (after.updates.length < before.updates.length) throw new GuardViolation('A finding keeps every update');
      if (after.number !== before.number || after.raisedById !== before.raisedById || after.testId !== before.testId) throw new GuardViolation('A finding keeps its number, who raised it and its source');
    },
    beforeDelete() {
      throw new GuardViolation('Audit findings are kept as a record');
    },
  },
});
