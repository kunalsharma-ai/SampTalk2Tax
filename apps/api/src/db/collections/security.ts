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

/**
 * Access rules (SEC-004, attribute-based access control): conditions on who may open an
 * organisation's books from where and when, on top of their role. A rule names roles and/or
 * people; for them, requests are allowed only from the listed networks and within the listed days
 * and hours (in the organisation's time zone). The owner is never bound, so nobody is locked out.
 */
export interface AccessRuleDoc {
  id: string;
  orgId: string;
  name: string;
  /** Roles bound by the rule (never OWNER). */
  roles: string[];
  /** People bound by the rule, by user id (never an owner). */
  userIds: string[];
  /** ALL: every request; CHANGES: only requests that change something. */
  appliesTo: 'ALL' | 'CHANGES';
  /** IPv4/IPv6 addresses or CIDR ranges allowed; empty: any network. */
  networks: string[];
  /** Days allowed, 0 = Sunday … 6 = Saturday; empty: every day. */
  days: number[];
  /** Minutes after midnight, organisation time; both null: any hour. End is exclusive. */
  startMinute: number | null;
  endMinute: number | null;
  active: boolean;
  createdById: string;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const accessRules = defineCollection<AccessRuleDoc>({
  name: 'access_rules',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'roles', 'userIds', 'appliesTo', 'networks', 'days', 'startMinute', 'endMinute', 'active', 'createdById', 'updatedById', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 120 },
      roles: { bsonType: 'array', items: { enum: ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER', 'EMPLOYEE'] } },
      userIds: { bsonType: 'array', items: { bsonType: 'string' } },
      appliesTo: { enum: ['ALL', 'CHANGES'] },
      networks: { bsonType: 'array', items: { bsonType: 'string' }, maxItems: 50 },
      days: { bsonType: 'array', items: { bsonType: 'int', minimum: 0, maximum: 6 } },
      startMinute: { bsonType: ['int', 'null'], minimum: 0, maximum: 1439 },
      endMinute: { bsonType: ['int', 'null'], minimum: 1, maximum: 1440 },
      active: { bsonType: 'bool' },
      createdById: { bsonType: 'string' },
      updatedById: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, active: 1 }, name: 'org_active' }],
});
