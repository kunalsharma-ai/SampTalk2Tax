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

/** What a US vendor's Form W-9 says (TAX-029), for 1099 reporting. Only the last four digits of the taxpayer number are kept. One per vendor. */
export interface UsVendorTaxProfileDoc {
  id: string;
  orgId: string;
  contactId: string;
  classification: 'INDIVIDUAL' | 'PARTNERSHIP' | 'C_CORPORATION' | 'S_CORPORATION' | 'TRUST_ESTATE' | 'LLC_C' | 'LLC_S' | 'LLC_P' | 'EXEMPT_PAYEE';
  tinType: 'SSN' | 'EIN';
  tinLast4: string | null;
  w9ReceivedOn: string | null;
  formKind: 'NEC' | 'MISC_RENT' | 'MISC_OTHER' | 'NONE';
  isAttorney: boolean;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const usVendorTaxProfiles = defineCollection<UsVendorTaxProfileDoc>({
  name: 'us_vendor_tax_profiles',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'contactId', 'classification', 'tinType', 'formKind', 'isAttorney', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      contactId: { bsonType: 'string' },
      classification: { enum: ['INDIVIDUAL', 'PARTNERSHIP', 'C_CORPORATION', 'S_CORPORATION', 'TRUST_ESTATE', 'LLC_C', 'LLC_S', 'LLC_P', 'EXEMPT_PAYEE'] },
      tinType: { enum: ['SSN', 'EIN'] },
      tinLast4: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{4}$' }] },
      w9ReceivedOn: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' }] },
      formKind: { enum: ['NEC', 'MISC_RENT', 'MISC_OTHER', 'NONE'] },
      isAttorney: { bsonType: 'bool' },
      createdById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, contactId: 1 }, name: 'org_contact', unique: true }],
});
