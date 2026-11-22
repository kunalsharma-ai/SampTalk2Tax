import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Business trips (EXP-007): a traveller requests a trip with its purpose, place, dates and an
 * estimate; someone else approves or rejects it before travel; the traveller links their expense
 * claims to it. The request itself (purpose, place, dates, estimate) is fixed once made; a trip is
 * kept as a record and never deleted.
 */
export type TripStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ExpenseTripDoc {
  id: string;
  orgId: string;
  number: number;
  travellerId: string;
  purpose: string;
  destination: string;
  startDate: string;
  endDate: string;
  currency: string;
  estimate: { transport: string; lodging: string; meals: string; other: string };
  status: TripStatus;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  claimIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

const AMOUNT = { bsonType: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' };
const FIXED = ['travellerId', 'purpose', 'destination', 'startDate', 'endDate', 'currency', 'estimate', 'number'] as const;
const MOVES: Record<TripStatus, TripStatus[]> = { REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'], APPROVED: ['CANCELLED'], REJECTED: [], CANCELLED: [] };

export const expenseTrips = defineCollection<ExpenseTripDoc>({
  name: 'expense_trips',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'travellerId', 'purpose', 'destination', 'startDate', 'endDate', 'currency', 'estimate', 'status', 'claimIds', 'createdAt', 'updatedAt'],
    properties: {
      purpose: { bsonType: 'string', minLength: 1, maxLength: 200 },
      destination: { bsonType: 'string', minLength: 1, maxLength: 120 },
      startDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      endDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      status: { enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      estimate: { bsonType: 'object', required: ['transport', 'lodging', 'meals', 'other'], properties: { transport: AMOUNT, lodging: AMOUNT, meals: AMOUNT, other: AMOUNT } },
      claimIds: { bsonType: 'array', items: { bsonType: 'string' } },
      decisionNote: { bsonType: ['string', 'null'], maxLength: 500 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'trip_number', unique: true },
    { key: { orgId: 1, claimIds: 1 }, name: 'trip_claims' },
  ],
  guards: {
    beforeInsert(t) {
      if (t.endDate < t.startDate) throw new GuardViolation('A trip ends on or after it starts');
      if (t.status !== 'REQUESTED' || t.claimIds.length) throw new GuardViolation('A trip starts as a request with no claims');
    },
    afterUpdate(before, after) {
      for (const k of FIXED) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) throw new GuardViolation('A trip request is not changed once made; cancel it and request another');
      if (before.status !== after.status && !MOVES[before.status].includes(after.status)) throw new GuardViolation(`A ${before.status.toLowerCase()} trip cannot become ${after.status.toLowerCase()}`);
      if ((after.status === 'APPROVED' || after.status === 'REJECTED') && (!after.decidedById || !after.decidedAt)) throw new GuardViolation('A trip is decided with who and when');
      if (after.decidedById && after.decidedById === after.travellerId) throw new GuardViolation('A traveller does not decide on their own trip');
      if (new Set(after.claimIds).size !== after.claimIds.length) throw new GuardViolation('A claim is linked to a trip once');
      if (after.claimIds.length > before.claimIds.length && after.status !== 'APPROVED') throw new GuardViolation('Claims are linked to approved trips');
    },
    beforeDelete() {
      throw new GuardViolation('Trips are kept as a record');
    },
  },
});
