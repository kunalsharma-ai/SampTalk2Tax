import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Vendor contracts (AP-032): the agreed terms with a vendor that posted bills are checked against:
 * the period, payment terms, a spend cap and a price list by item (HSN/SAC code or description).
 * A contract only changes by being terminated, and is kept as a record.
 */
export interface VendorContractPrice {
  /** negotiationItemKey of the entry: 'hsn:7208' or 'desc:delivery charge'. */
  key: string;
  label: string;
  hsnCode: string | null;
  /** Per unit, functional currency. */
  unitPrice: string;
}

export interface VendorContractDoc {
  id: string;
  orgId: string;
  number: number;
  contactId: string;
  title: string;
  vendorReference: string | null;
  startDate: string;
  endDate: string;
  currency: string;
  paymentTermsDays: number | null;
  spendCap: string | null;
  itemsOnly: boolean;
  prices: VendorContractPrice[];
  note: string | null;
  status: 'ACTIVE' | 'TERMINATED';
  createdById: string;
  createdAt: Date;
  terminatedOn: string | null;
  terminatedById: string | null;
  terminatedAt: Date | null;
  terminateReason: string | null;
}

const FIXED = ['number', 'contactId', 'title', 'vendorReference', 'startDate', 'endDate', 'currency', 'paymentTermsDays', 'spendCap', 'itemsOnly', 'prices', 'note', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const AMOUNT = '^[0-9]+(\\.[0-9]+)?$';

export const vendorContracts = defineCollection<VendorContractDoc>({
  name: 'vendor_contracts',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'number', 'contactId', 'title', 'startDate', 'endDate', 'currency', 'itemsOnly', 'prices', 'status', 'createdById', 'createdAt'],
    properties: {
      number: { bsonType: 'int', minimum: 1 },
      title: { bsonType: 'string', minLength: 1, maxLength: 200 },
      vendorReference: { bsonType: ['string', 'null'], maxLength: 100 },
      startDate: { bsonType: 'string', pattern: DATE },
      endDate: { bsonType: 'string', pattern: DATE },
      paymentTermsDays: { bsonType: ['int', 'null'], minimum: 0, maximum: 365 },
      spendCap: { bsonType: ['string', 'null'], pattern: AMOUNT },
      itemsOnly: { bsonType: 'bool' },
      prices: { bsonType: 'array', maxItems: 200 },
      note: { bsonType: ['string', 'null'], maxLength: 1000 },
      status: { enum: ['ACTIVE', 'TERMINATED'] },
      terminatedOn: { bsonType: ['string', 'null'] },
      terminateReason: { bsonType: ['string', 'null'], maxLength: 1000 },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'one_number', unique: true },
    { key: { orgId: 1, contactId: 1, status: 1 }, name: 'by_vendor' },
  ],
  guards: {
    beforeInsert(c) {
      if (c.endDate < c.startDate) throw new GuardViolation('A contract ends on or after it starts');
      if (c.status !== 'ACTIVE') throw new GuardViolation('A contract starts active');
      if (new Set(c.prices.map((p) => p.key)).size !== c.prices.length) throw new GuardViolation('Each item is priced once in a contract');
    },
    afterUpdate(before, after) {
      if (before.status === 'TERMINATED') throw new GuardViolation('A terminated contract is kept as it was');
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('A contract keeps its terms; terminate it and record a new one');
      if (after.status === 'TERMINATED' && (!after.terminatedOn || !after.terminatedById || !after.terminatedAt || !after.terminateReason)) throw new GuardViolation('A contract is terminated with the date, who, when and why');
    },
    beforeDelete() {
      throw new GuardViolation('Vendor contracts are kept as a record');
    },
  },
});
