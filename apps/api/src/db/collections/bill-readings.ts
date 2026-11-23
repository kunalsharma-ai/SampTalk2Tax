import { defineCollection, GuardViolation } from '@talk2tax/document-db';
import type { StoredBytes } from '../../files/file-vault';

/**
 * Bills read from a file or pasted text (AP-025): the file as uploaded (encrypted at rest), the
 * text read from it, and what the bill reader found. A person reviews the result in the bill
 * form and saves it as a draft bill, which links the reading to the bill and attaches the file;
 * or discards it. What was read never changes, so the audit trail can show what the person
 * corrected. Never deleted.
 */
export interface BillReadingDoc {
  id: string;
  orgId: string;
  number: number;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  sizeBytes: number;
  sha256: string;
  /** The PDF's bytes, sealed by the file vault; null for pasted text. */
  content: StoredBytes | null;
  contentKeyId: string | null;
  text: string;
  pages: number;
  /** What the reader found (ExtractedBill from the engine, with suggestions added). */
  result: Record<string, unknown>;
  status: 'READ' | 'SAVED' | 'DISCARDED';
  documentId: string | null;
  attachmentId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

const FIXED = ['number', 'source', 'fileName', 'sizeBytes', 'sha256', 'text', 'pages', 'result', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const billReadings = defineCollection<BillReadingDoc>({
  name: 'bill_readings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'source', 'sizeBytes', 'sha256', 'text', 'pages', 'result', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      source: { enum: ['PDF', 'TEXT'] },
      fileName: { bsonType: ['string', 'null'], maxLength: 255 },
      sizeBytes: { bsonType: 'int', minimum: 1 },
      sha256: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      text: { bsonType: 'string', maxLength: 200000 },
      pages: { bsonType: 'int', minimum: 0 },
      result: { bsonType: 'object' },
      status: { enum: ['READ', 'SAVED', 'DISCARDED'] },
      documentId: { bsonType: ['string', 'null'] },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'bill_readings_number', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'bill_readings_recent' },
  ],
  guards: {
    afterUpdate(before, after) {
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('What was read from a bill does not change');
      if (before.status !== 'READ') throw new GuardViolation('A bill reading that was saved or discarded is final');
      if (after.status === 'SAVED' && !after.documentId) throw new GuardViolation('A saved bill reading names its bill');
    },
    beforeDelete() {
      throw new GuardViolation('Bill readings are kept');
    },
  },
});
