import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * External communication (AR-043). A contact's email consent is kept as a history: each change is
 * a new record with who recorded it and why, and the latest one counts. The organisation's policy
 * is one record per organisation.
 */
export interface ContactEmailConsentDoc {
  id: string;
  orgId: string;
  contactId: string;
  status: 'OPTED_OUT' | 'OPTED_IN';
  reason: string;
  recordedById: string;
  recordedAt: Date;
}

export const contactEmailConsents = defineCollection<ContactEmailConsentDoc>({
  name: 'contact_email_consents',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'contactId', 'status', 'reason', 'recordedById', 'recordedAt'],
    properties: {
      status: { enum: ['OPTED_OUT', 'OPTED_IN'] },
      reason: { bsonType: 'string', minLength: 3, maxLength: 500 },
      recordedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, contactId: 1, recordedAt: -1 }, name: 'org_contact_recorded' }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('Email consent history is kept as recorded');
    },
    beforeDelete() {
      throw new GuardViolation('Email consent history is kept as recorded');
    },
  },
});

export interface CommunicationPolicyDoc {
  id: string;
  orgId: string;
  automationsToContacts: 'ALLOWED' | 'BLOCKED';
  updatedById: string;
  updatedAt: Date;
}

export const communicationPolicies = defineCollection<CommunicationPolicyDoc>({
  name: 'communication_policies',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'automationsToContacts', 'updatedById', 'updatedAt'],
    properties: {
      automationsToContacts: { enum: ['ALLOWED', 'BLOCKED'] },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1 }, name: 'org_unique', unique: true }],
  guards: {
    beforeDelete() {
      throw new GuardViolation('A communication policy is changed, never deleted');
    },
  },
});
