import { defineCollection } from '@talk2tax/document-db';

/**
 * An organisation's sign-in rules (SEC-005): whether every member must have two-step sign-in
 * on to open its books. One document per organisation; none means nothing is required.
 */
export interface OrgSecuritySettingsDoc {
  id: string;
  orgId: string;
  requireTwoStep: boolean;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const orgSecuritySettings = defineCollection<OrgSecuritySettingsDoc>({
  name: 'org_security_settings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'requireTwoStep', 'updatedById', 'createdAt', 'updatedAt'],
    properties: {
      requireTwoStep: { bsonType: 'bool' },
      updatedById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1 }, name: 'org', unique: true }],
});
