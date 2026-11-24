import { defineCollection } from '@talk2tax/document-db';

/** A US state the business holds a sales tax permit in (TAX-028), with the combined rate it charges there. One per state. */
export interface UsSalesTaxRegistrationDoc {
  id: string;
  orgId: string;
  state: string;
  registeredFrom: string;
  permitNumber: string | null;
  taxRateId: string | null;
  filingFrequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const usSalesTaxRegistrations = defineCollection<UsSalesTaxRegistrationDoc>({
  name: 'us_sales_tax_registrations',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'state', 'registeredFrom', 'filingFrequency', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      state: { bsonType: 'string', pattern: '^[A-Z]{2}$' },
      registeredFrom: { bsonType: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
      permitNumber: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', maxLength: 50 }] },
      taxRateId: { bsonType: ['string', 'null'] },
      filingFrequency: { enum: ['MONTHLY', 'QUARTERLY', 'ANNUAL'] },
      createdById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, state: 1 }, name: 'org_state', unique: true }],
});
