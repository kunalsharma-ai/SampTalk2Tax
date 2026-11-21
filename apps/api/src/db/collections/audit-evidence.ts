import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Audit evidence requests (AUDIT-003): what an internal audit engagement asks a member to provide,
 * by when, the files submitted (each with its SHA-256 at submission) and who accepted them. The
 * request itself never changes; history is only added to; accepted evidence is kept as accepted.
 */
export interface EvidenceFileRef {
  attachmentId: string;
  fileName: string;
  sha256: string;
}

export interface AuditEvidenceRequestDoc {
  id: string;
  orgId: string;
  number: number;
  engagementId: string;
  title: string;
  details: string;
  ownerId: string;
  dueDate: Date;
  status: 'REQUESTED' | 'SUBMITTED' | 'ACCEPTED';
  files: EvidenceFileRef[];
  submittedById: string | null;
  submittedAt: Date | null;
  acceptedById: string | null;
  acceptedAt: Date | null;
  history: { at: Date; byId: string; action: string; note: string }[];
  requestedById: string;
  requestedAt: Date;
}

const FIXED = ['number', 'engagementId', 'title', 'details', 'ownerId', 'dueDate', 'requestedById', 'requestedAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const auditEvidenceRequests = defineCollection<AuditEvidenceRequestDoc>({
  name: 'audit_evidence_requests',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'engagementId', 'title', 'details', 'ownerId', 'dueDate', 'status', 'files', 'history', 'requestedById', 'requestedAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      title: { bsonType: 'string', minLength: 1, maxLength: 200 },
      details: { bsonType: 'string', maxLength: 2000 },
      status: { enum: ['REQUESTED', 'SUBMITTED', 'ACCEPTED'] },
      files: { bsonType: 'array', maxItems: 20 },
      history: { bsonType: 'array' },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, engagementId: 1 }, name: 'by_engagement' },
    { key: { orgId: 1, ownerId: 1, status: 1 }, name: 'by_owner' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'ACCEPTED') throw new GuardViolation('Accepted evidence is kept as it was accepted');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('An evidence request keeps what it asked for');
      if (after.history.length < before.history.length || !before.history.every((h, i) => same(h, after.history[i]))) throw new GuardViolation('Evidence history is only added to');
      if (after.status !== 'REQUESTED' && !after.files.length) throw new GuardViolation('Submitted evidence has at least one file');
      if (after.status === 'ACCEPTED' && (!after.acceptedById || after.acceptedById === after.submittedById)) throw new GuardViolation('Someone other than the person who submitted it accepts the evidence');
    },
    beforeDelete() {
      throw new GuardViolation('Evidence requests are kept as a record');
    },
  },
});
