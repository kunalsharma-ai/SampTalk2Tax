import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Agreed customer payment plans (AR-040): the overdue invoices a customer agreed to pay in
 * instalments, what each owed when the plan was agreed, and the instalment schedule. Progress is
 * worked out from what has been received since, so the plan itself only ever changes by being
 * cancelled, and is kept as a record.
 */
export interface PaymentPlanInvoice {
  id: string;
  number: string;
  /** Outstanding when the plan was agreed, functional currency. */
  outstanding: string;
}

export interface PaymentPlanDoc {
  id: string;
  orgId: string;
  number: number;
  contactId: string;
  currency: string;
  total: string;
  invoices: PaymentPlanInvoice[];
  instalments: { no: number; dueDate: string; amount: string }[];
  /** The plan the system suggested, kept so the agreed one can be compared with it. */
  suggestedInstalments: number;
  note: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  createdById: string;
  createdAt: Date;
  cancelledById: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

const FIXED = ['number', 'contactId', 'currency', 'total', 'invoices', 'instalments', 'suggestedInstalments', 'note', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const paymentPlans = defineCollection<PaymentPlanDoc>({
  name: 'payment_plans',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'contactId', 'currency', 'total', 'invoices', 'instalments', 'suggestedInstalments', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      total: { bsonType: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' },
      invoices: { bsonType: 'array', minItems: 1, maxItems: 500 },
      instalments: { bsonType: 'array', minItems: 1, maxItems: 12 },
      suggestedInstalments: { bsonType: 'int', minimum: 1, maximum: 12 },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
      status: { enum: ['ACTIVE', 'CANCELLED'] },
      cancelReason: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, contactId: 1, status: 1 }, name: 'by_customer' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status === 'CANCELLED') throw new GuardViolation('A cancelled payment plan is kept as it was');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('An agreed payment plan keeps its invoices and instalments; cancel it and agree a new one');
      if (after.status === 'CANCELLED' && (!after.cancelledById || !after.cancelledAt || !after.cancelReason)) throw new GuardViolation('A plan is cancelled with who, when and why');
    },
    beforeDelete() {
      throw new GuardViolation('Payment plans are kept as a record');
    },
  },
});
