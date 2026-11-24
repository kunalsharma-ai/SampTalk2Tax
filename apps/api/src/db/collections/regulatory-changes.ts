import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/** A known law change an organisation has dealt with (TAX-046), with who recorded it and how. One per change; final. */
export interface RegulatoryChangeAckDoc {
  id: string;
  orgId: string;
  changeKey: string;
  note: string | null;
  acknowledgedById: string;
  createdAt: Date;
}

export const regulatoryChangeAcks = defineCollection<RegulatoryChangeAckDoc>({
  name: 'regulatory_change_acks',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'changeKey', 'acknowledgedById', 'createdAt'],
    properties: {
      changeKey: { bsonType: 'string', pattern: '^[A-Z0-9-]{3,80}$' },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
      acknowledgedById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, changeKey: 1 }, name: 'org_change', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A recorded regulatory change is final');
    },
    beforeDelete() {
      throw new GuardViolation('Recorded regulatory changes are kept');
    },
  },
});
