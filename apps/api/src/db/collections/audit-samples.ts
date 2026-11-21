import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Audit samples (AUDIT-009): transactions picked from a period's population for testing, with
 * the seed that picked them, so the same sample can be drawn again and checked. The selection
 * never changes; each item's result is recorded once, and a completed sample is kept as it was.
 */
export interface SampleItem {
  refId: string;
  label: string;
  date: Date;
  amount: string;
  reason: 'RANDOM' | 'MONETARY_UNIT' | 'HIGH_VALUE' | 'ABOVE_INTERVAL';
  result: 'OK' | 'EXCEPTION' | null;
  note: string | null;
  testedById: string | null;
  testedAt: Date | null;
}

export interface AuditSampleDoc {
  id: string;
  orgId: string;
  number: number;
  name: string;
  population: 'JOURNALS' | 'BILLS' | 'INVOICES' | 'PAYMENTS';
  from: Date;
  to: Date;
  method: 'RANDOM' | 'MONETARY_UNIT' | 'HIGH_VALUE';
  size: number;
  seed: string;
  threshold: string | null;
  interval: string | null;
  populationCount: number;
  populationTotal: string;
  fingerprint: string;
  items: SampleItem[];
  status: 'OPEN' | 'COMPLETED';
  createdById: string;
  createdAt: Date;
  completedAt: Date | null;
}

/** What a sample's selection is: none of it may change once drawn. */
const FIXED = ['number', 'name', 'population', 'from', 'to', 'method', 'size', 'seed', 'threshold', 'interval', 'populationCount', 'populationTotal', 'fingerprint', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const auditSamples = defineCollection<AuditSampleDoc>({
  name: 'audit_samples',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'name', 'population', 'from', 'to', 'method', 'size', 'seed', 'populationCount', 'populationTotal', 'fingerprint', 'items', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      name: { bsonType: 'string', minLength: 1, maxLength: 120 },
      population: { enum: ['JOURNALS', 'BILLS', 'INVOICES', 'PAYMENTS'] },
      method: { enum: ['RANDOM', 'MONETARY_UNIT', 'HIGH_VALUE'] },
      size: { bsonType: 'int', minimum: 1, maximum: 200 },
      seed: { bsonType: 'string', minLength: 1, maxLength: 80 },
      items: { bsonType: 'array', maxItems: 200 },
      status: { enum: ['OPEN', 'COMPLETED'] },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, createdAt: -1 }, name: 'by_created' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'COMPLETED') throw new GuardViolation('A completed sample is kept as it was completed');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('A sample keeps the selection it was drawn with');
      if (after.items.length !== before.items.length) throw new GuardViolation('A sample keeps the items it was drawn with');
      after.items.forEach((a, i) => {
        const b = before.items[i]!;
        if (a.refId !== b.refId || a.amount !== b.amount || a.reason !== b.reason || a.label !== b.label) throw new GuardViolation('A sample keeps the items it was drawn with');
        if (b.result && (a.result !== b.result || a.note !== b.note || a.testedById !== b.testedById)) throw new GuardViolation('An item result is recorded once');
      });
      if (after.status === 'COMPLETED' && after.items.some((i) => !i.result)) throw new GuardViolation('A sample completes once every item is tested');
    },
    beforeDelete() {
      throw new GuardViolation('Audit samples are kept as a record');
    },
  },
});
