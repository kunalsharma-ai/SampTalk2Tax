import type { Binary } from '@talk2tax/document-db';
import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Tax notices (TAX-024): letters from tax authorities, their reply deadline, what was done and
 * how they ended. The history of a notice only grows; its files are kept as uploaded.
 */

export type TaxAuthorityName = 'GST' | 'INCOME_TAX' | 'TDS' | 'PF' | 'ESI' | 'PROFESSIONAL_TAX' | 'OTHER';
export type TaxNoticeStatusName = 'OPEN' | 'RESPONDED' | 'CLOSED';
export type TaxNoticeOutcomeName = 'DROPPED' | 'DEMAND_PAID' | 'APPEALED' | 'OTHER';
export type TaxNoticeEventKind = 'RECEIVED' | 'UPDATED' | 'NOTE' | 'FILE' | 'RESPONDED' | 'CLOSED' | 'REOPENED';

export interface TaxNoticeEvent {
  id: string;
  kind: TaxNoticeEventKind;
  /** The day it happened (a reply's date can be earlier than when it was recorded). */
  on: Date;
  text: string | null;
  byId: string;
  at: Date;
}

export interface TaxNoticeDoc {
  id: string;
  orgId: string;
  authority: TaxAuthorityName;
  reference: string;
  section: string | null;
  subject: string;
  period: string | null;
  receivedOn: Date;
  responseDue: Date | null;
  demand: string | null;
  status: TaxNoticeStatusName;
  outcome: TaxNoticeOutcomeName | null;
  assigneeId: string | null;
  events: TaxNoticeEvent[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const taxNotices = defineCollection<TaxNoticeDoc>({
  name: 'tax_notices',
  scope: 'tenant',
  decimals: ['demand'],
  schema: {
    bsonType: 'object',
    required: ['orgId', 'authority', 'reference', 'subject', 'receivedOn', 'status', 'events', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      authority: { enum: ['GST', 'INCOME_TAX', 'TDS', 'PF', 'ESI', 'PROFESSIONAL_TAX', 'OTHER'] },
      reference: { bsonType: 'string', minLength: 1, maxLength: 100 },
      subject: { bsonType: 'string', minLength: 1, maxLength: 300 },
      receivedOn: { bsonType: 'date' },
      responseDue: { bsonType: ['date', 'null'] },
      demand: { bsonType: ['decimal', 'null'] },
      status: { enum: ['OPEN', 'RESPONDED', 'CLOSED'] },
      outcome: { enum: ['DROPPED', 'DEMAND_PAID', 'APPEALED', 'OTHER', null] },
      events: { bsonType: 'array', minItems: 1 },
    },
  },
  indexes: [
    { key: { orgId: 1, authority: 1, reference: 1 }, name: 'org_authority_reference', unique: true, collation: { locale: 'en', strength: 2 } },
    { key: { orgId: 1, status: 1, responseDue: 1 }, name: 'org_status_due' },
  ],
  guards: {
    beforeInsert(n) {
      if (n.status !== 'OPEN' || n.outcome !== null) throw new GuardViolation('A notice starts open');
    },
    afterUpdate(before, after) {
      if (after.authority !== before.authority || after.createdById !== before.createdById) throw new GuardViolation('A notice keeps its authority');
      if (after.events.length < before.events.length || before.events.some((e, i) => after.events[i]?.id !== e.id)) throw new GuardViolation('The history of a notice only grows');
      if ((after.status === 'CLOSED') !== (after.outcome !== null)) throw new GuardViolation('A closed notice has an outcome, and only a closed one does');
    },
    beforeDelete() {
      throw new GuardViolation('A tax notice is kept; close it instead');
    },
  },
});

/** A notice's files: the letter, the reply sent, orders and challans. Kept exactly as uploaded. */
export interface TaxNoticeFileDoc {
  id: string;
  orgId: string;
  noticeId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  content: Binary | Buffer;
  uploadedById: string;
  createdAt: Date;
}

export const taxNoticeFiles = defineCollection<TaxNoticeFileDoc>({
  name: 'tax_notice_files',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['noticeId', 'fileName', 'contentType', 'sizeBytes', 'sha256', 'content', 'uploadedById', 'createdAt'],
    properties: {
      contentType: { enum: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] },
      sha256: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      sizeBytes: { bsonType: ['int', 'long'], minimum: 1, maximum: 5242880 },
      content: { bsonType: 'binData' },
    },
  },
  indexes: [{ key: { orgId: 1, noticeId: 1 }, name: 'org_notice' }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A notice file is kept as uploaded');
    },
    beforeDelete() {
      throw new GuardViolation('A notice file is kept as uploaded');
    },
  },
});
