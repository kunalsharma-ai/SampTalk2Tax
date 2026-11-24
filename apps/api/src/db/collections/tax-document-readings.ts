import { defineCollection, GuardViolation } from '@talk2tax/document-db';
import type { StoredBytes } from '../../files/file-vault';

/**
 * Tax documents read from a PDF or pasted text (TAX-043): the file as uploaded (encrypted at
 * rest), the text read from it and what was found. What was read never changes; a person marks a
 * reading reviewed once they have acted on it. Never deleted.
 */
export interface TaxDocumentReadingDoc {
  id: string;
  orgId: string;
  number: number;
  source: 'PDF' | 'TEXT';
  fileName: string | null;
  sizeBytes: number;
  sha256: string;
  content: StoredBytes | null;
  contentKeyId: string | null;
  text: string;
  pages: number;
  kind: 'TDS_CERTIFICATE' | 'ANNUAL_TAX_STATEMENT' | 'GST_CHALLAN' | 'FORM_1099' | 'UNKNOWN';
  result: Record<string, unknown>;
  status: 'READ' | 'REVIEWED';
  reviewNote: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

const FIXED = ['number', 'source', 'fileName', 'sizeBytes', 'sha256', 'text', 'pages', 'kind', 'result', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const taxDocumentReadings = defineCollection<TaxDocumentReadingDoc>({
  name: 'tax_document_readings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'source', 'sizeBytes', 'sha256', 'text', 'pages', 'kind', 'result', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      source: { enum: ['PDF', 'TEXT'] },
      fileName: { bsonType: ['string', 'null'], maxLength: 255 },
      sizeBytes: { bsonType: 'int', minimum: 1 },
      sha256: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      text: { bsonType: 'string', maxLength: 200000 },
      pages: { bsonType: 'int', minimum: 0 },
      kind: { enum: ['TDS_CERTIFICATE', 'ANNUAL_TAX_STATEMENT', 'GST_CHALLAN', 'FORM_1099', 'UNKNOWN'] },
      result: { bsonType: 'object' },
      status: { enum: ['READ', 'REVIEWED'] },
      reviewNote: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'tax_document_readings_number', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'tax_document_readings_recent' },
  ],
  guards: {
    afterUpdate(before, after) {
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('What was read from a tax document does not change');
      if (before.status !== 'READ') throw new GuardViolation('A reviewed tax document reading is final');
    },
    beforeDelete() {
      throw new GuardViolation('Tax document readings are kept');
    },
  },
});
