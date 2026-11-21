import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Internal audit engagements (AUDIT-001): the scope, lead and reviewer of an internal audit, its
 * work programme of steps, the samples and findings it uses, and every move kept in order. Steps,
 * links and history are only ever added to; a signed-off step and a closed engagement are kept as
 * they were.
 */
export interface EngagementStepDoc {
  id: string;
  title: string;
  assigneeId: string;
  status: 'OPEN' | 'DONE' | 'SIGNED_OFF';
  work: string | null;
  doneById: string | null;
  doneAt: Date | null;
  signedOffById: string | null;
  signedOffAt: Date | null;
}

export interface EngagementEvent {
  at: Date;
  byId: string;
  action: string;
  note: string;
}

export interface AuditEngagementDoc {
  id: string;
  orgId: string;
  number: number;
  name: string;
  objective: string;
  scopeFrom: Date;
  scopeTo: Date;
  leadId: string;
  reviewerId: string;
  status: 'PLANNING' | 'FIELDWORK' | 'REVIEW' | 'CLOSED';
  steps: EngagementStepDoc[];
  sampleIds: string[];
  findingIds: string[];
  conclusion: string | null;
  history: EngagementEvent[];
  createdById: string;
  createdAt: Date;
  closedAt: Date | null;
}

const FIXED = ['number', 'name', 'objective', 'scopeFrom', 'scopeTo', 'leadId', 'reviewerId', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const grows = <T>(before: T[], after: T[]) => after.length >= before.length && before.every((x, i) => same(x, after[i]));

export const auditEngagements = defineCollection<AuditEngagementDoc>({
  name: 'audit_engagements',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'name', 'objective', 'scopeFrom', 'scopeTo', 'leadId', 'reviewerId', 'status', 'steps', 'sampleIds', 'findingIds', 'history', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      name: { bsonType: 'string', minLength: 1, maxLength: 120 },
      objective: { bsonType: 'string', minLength: 1, maxLength: 2000 },
      status: { enum: ['PLANNING', 'FIELDWORK', 'REVIEW', 'CLOSED'] },
      steps: { bsonType: 'array', maxItems: 100 },
      sampleIds: { bsonType: 'array', maxItems: 50 },
      findingIds: { bsonType: 'array', maxItems: 100 },
      history: { bsonType: 'array' },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, status: 1 }, name: 'by_status' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'CLOSED') throw new GuardViolation('A closed engagement is kept as it was closed');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('An engagement keeps its scope, lead and reviewer');
      if (!grows(before.history, after.history)) throw new GuardViolation('Engagement history is only added to');
      if (!grows(before.sampleIds, after.sampleIds) || !grows(before.findingIds, after.findingIds)) throw new GuardViolation('Linked samples and findings stay linked');
      if (after.steps.length < before.steps.length) throw new GuardViolation('Steps are not removed from the work programme');
      before.steps.forEach((b, i) => {
        const a = after.steps[i]!;
        if (a.id !== b.id || a.title !== b.title || a.assigneeId !== b.assigneeId) throw new GuardViolation('A step keeps its title and assignee');
        if (b.status === 'SIGNED_OFF' && !same(a, b)) throw new GuardViolation('A signed-off step is kept as signed off');
      });
      for (const s of after.steps) if (s.signedOffById && s.signedOffById === s.doneById) throw new GuardViolation('The reviewer cannot sign off work they did themselves');
      if (after.status === 'CLOSED' && (!after.conclusion || after.steps.some((s) => s.status !== 'SIGNED_OFF'))) throw new GuardViolation('An engagement closes with a conclusion once every step is signed off');
    },
    beforeDelete() {
      throw new GuardViolation('Audit engagements are kept as a record');
    },
  },
});
