import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Compliance documents (TAX-025): acknowledgements, challans, copies of returns, working papers,
 * registration certificates and notices, each tied to a compliance obligation (its key, name and
 * period at the time) or kept for the organisation, with the date to keep it until. The files are
 * attachments with entity COMPLIANCE_DOCUMENT. What a record says never changes; a record added
 * by mistake is voided with a reason and kept.
 */
export interface ComplianceDocumentDoc {
  id: string;
  orgId: string;
  number: number;
  kind: 'ACKNOWLEDGEMENT' | 'CHALLAN' | 'RETURN_COPY' | 'WORKING' | 'REGISTRATION' | 'NOTICE' | 'OTHER';
  obligationKey: string | null;
  obligationName: string | null;
  periodLabel: string | null;
  title: string;
  reference: string | null;
  note: string | null;
  retainUntil: string | null;
  status: 'ACTIVE' | 'VOID';
  voidReason: string | null;
  voidedById: string | null;
  voidedAt: Date | null;
  createdById: string;
  createdAt: Date;
}

const FIXED = ['number', 'kind', 'obligationKey', 'obligationName', 'periodLabel', 'title', 'reference', 'note', 'retainUntil', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const complianceDocuments = defineCollection<ComplianceDocumentDoc>({
  name: 'compliance_documents',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'kind', 'title', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      kind: { enum: ['ACKNOWLEDGEMENT', 'CHALLAN', 'RETURN_COPY', 'WORKING', 'REGISTRATION', 'NOTICE', 'OTHER'] },
      obligationKey: { bsonType: ['string', 'null'], maxLength: 60 },
      title: { bsonType: 'string', minLength: 1, maxLength: 200 },
      reference: { bsonType: ['string', 'null'], maxLength: 100 },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
      retainUntil: { bsonType: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      status: { enum: ['ACTIVE', 'VOID'] },
      voidReason: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, obligationKey: 1 }, name: 'by_obligation' },
    { key: { orgId: 1, kind: 1, status: 1 }, name: 'by_kind' },
  ],
  guards: {
    beforeInsert(d) {
      if (d.status !== 'ACTIVE') throw new GuardViolation('A compliance document starts active');
    },
    afterUpdate(before, after) {
      if (before.status === 'VOID') throw new GuardViolation('A void compliance document stays void');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('What a compliance document record says cannot be changed');
      if (after.status === 'VOID' && !after.voidReason) throw new GuardViolation('A void compliance document says why');
    },
    beforeDelete() {
      throw new GuardViolation('Compliance documents are kept as a record');
    },
  },
});
