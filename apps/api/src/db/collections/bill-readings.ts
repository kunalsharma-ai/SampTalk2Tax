import { defineCollection, GuardViolation } from '@talk2tax/document-db';
import type { StoredBytes } from '../../files/file-vault';

/**
 * Bills read from a file or pasted text (AP-025): the file as uploaded (encrypted at rest), the
 * text read from it, and what the bill reader found. A person reviews the result in the bill
 * form and saves it as a draft bill, which links the reading to the bill and attaches the file;
 * or discards it. What was read never changes, so the audit trail can show what the person
 * corrected. Never deleted.
 *
 * A PDF is read in the background (PERF-013): the upload is kept as QUEUED, a worker takes it
 * (READING, with a lease so a worker that stops is replaced) and leaves it READ, or FAILED with
 * the reason. Its text, pages and result are written once, when it is read.
 */
export type BillReadingStatus = 'QUEUED' | 'READING' | 'READ' | 'FAILED' | 'SAVED' | 'DISCARDED';
/** Waiting for, or being read by, the background worker. */
export const PENDING_READING: readonly BillReadingStatus[] = ['QUEUED', 'READING'];

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
  status: BillReadingStatus;
  /** How many times a worker took it (background reading). */
  attempts?: number;
  /** Until when the worker reading it holds it; another worker may take it after. */
  leaseUntil?: Date | null;
  /** Why it could not be read (FAILED). */
  failure?: string | null;
  /** When the reading finished, READ or FAILED. */
  readAt?: Date | null;
  documentId: string | null;
  attachmentId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

const FIXED = ['number', 'source', 'fileName', 'sizeBytes', 'sha256', 'createdById', 'createdAt'] as const;
/** Written once, when the reading finishes. */
const READ_ONCE = ['text', 'pages', 'result'] as const;
/** The moves a reading may make. */
const NEXT: Record<BillReadingStatus, readonly BillReadingStatus[]> = {
  QUEUED: ['READING', 'FAILED'],
  READING: ['READING', 'QUEUED', 'READ', 'FAILED'],
  READ: ['SAVED', 'DISCARDED'],
  FAILED: [],
  SAVED: [],
  DISCARDED: [],
};
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
      status: { enum: ['QUEUED', 'READING', 'READ', 'FAILED', 'SAVED', 'DISCARDED'] },
      documentId: { bsonType: ['string', 'null'] },
      attempts: { bsonType: 'int', minimum: 0, maximum: 100 },
      leaseUntil: { bsonType: ['date', 'null'] },
      failure: { bsonType: ['string', 'null'], maxLength: 1000 },
      readAt: { bsonType: ['date', 'null'] },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'bill_readings_number', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'bill_readings_recent' },
    // The background worker finds readings waiting in every organisation (PERF-013).
    { key: { status: 1, leaseUntil: 1 }, name: 'bill_readings_waiting' },
  ],
  guards: {
    afterUpdate(before, after) {
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('What was read from a bill does not change');
      const pending = PENDING_READING.includes(before.status);
      if (!pending) for (const k of READ_ONCE) if (!same(before[k], after[k])) throw new GuardViolation('What was read from a bill does not change');
      if (before.status !== after.status && !NEXT[before.status].includes(after.status)) {
        throw new GuardViolation(before.status === 'SAVED' || before.status === 'DISCARDED' ? 'A bill reading that was saved or discarded is final' : `A bill reading cannot go from ${before.status} to ${after.status}`);
      }
      if (before.status === after.status && NEXT[before.status].length === 0) throw new GuardViolation('A bill reading that was saved or discarded is final');
      if (after.status === 'FAILED' && !after.failure) throw new GuardViolation('A failed bill reading says why');
      if (after.status === 'SAVED' && !after.documentId) throw new GuardViolation('A saved bill reading names its bill');
    },
    beforeDelete() {
      throw new GuardViolation('Bill readings are kept');
    },
  },
});
