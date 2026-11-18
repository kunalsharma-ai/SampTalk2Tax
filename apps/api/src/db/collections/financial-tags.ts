import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Financial tags (GL-031, GL-028): reporting dimensions an organization defines itself, such as
 * a location or a business unit. A journal line carries them in its `dimensions` field as
 * key -> value code. A tag's key never changes once lines may point at it, and values are only
 * switched off, never removed, so old lines keep a readable name.
 */

export interface FinancialTagValue {
  code: string;
  name: string;
  isActive: boolean;
}

export interface FinancialTagDoc {
  id: string;
  orgId: string;
  key: string;
  label: string;
  isActive: boolean;
  values: FinancialTagValue[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const financialTags = defineCollection<FinancialTagDoc>({
  name: 'financial_tags',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'key', 'label', 'isActive', 'values', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      key: { bsonType: 'string', pattern: '^[a-z][a-z0-9_]{0,31}$' },
      label: { bsonType: 'string', minLength: 1, maxLength: 60 },
      isActive: { bsonType: 'bool' },
      values: {
        bsonType: 'array',
        maxItems: 500,
        items: {
          bsonType: 'object',
          required: ['code', 'name', 'isActive'],
          properties: {
            code: { bsonType: 'string', pattern: '^[A-Z0-9][A-Z0-9_-]{0,19}$' },
            name: { bsonType: 'string', minLength: 1, maxLength: 100 },
            isActive: { bsonType: 'bool' },
          },
        },
      },
    },
  },
  indexes: [{ key: { orgId: 1, key: 1 }, name: 'org_key', unique: true }],
  guards: {
    afterUpdate(before, after) {
      if (after.key !== before.key) throw new GuardViolation('A tag keeps its key');
      const codes = new Set(after.values.map((v) => v.code));
      if (before.values.some((v) => !codes.has(v.code))) throw new GuardViolation('A tag value is switched off, not removed');
    },
    beforeDelete() {
      throw new GuardViolation('A tag is switched off, not deleted');
    },
  },
});
