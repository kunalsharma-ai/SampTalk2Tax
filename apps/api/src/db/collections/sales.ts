import { defineCollection, GuardViolation } from '@talk2tax/document-db';
import type { MovedTable } from '../moved-table';

/** Customers and vendors. */

export interface ContactDoc {
  id: string;
  orgId: string;
  name: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  gstin: string | null;
  stateCode: string | null;
  pan: string | null;
  withholdingSectionId: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  isCustomer: boolean;
  isVendor: boolean;
  paymentTermsDays: number;
  creditLimit: string | null;
  creditHold: boolean;
  creditHoldReason: string | null;
  creditHoldAt: Date | null;
  creditHoldById: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Were the contacts_*_chk constraints that span fields. */
function checkContact(c: ContactDoc) {
  if (!c.isCustomer && !c.isVendor) throw new GuardViolation('A contact must be a customer, a vendor or both');
  if (c.gstin !== null && c.stateCode !== c.gstin.slice(0, 2)) throw new GuardViolation("A registered contact's state is its GSTIN's first two digits");
  if (c.pan !== null && c.gstin !== null && c.gstin.slice(2, 12) !== c.pan) throw new GuardViolation('The PAN must match the GSTIN');
  if (c.creditHold && (!c.creditHoldReason || !c.creditHoldAt || !c.creditHoldById)) throw new GuardViolation('A credit hold needs its reason, time and who placed it');
}

export const contacts = defineCollection<ContactDoc>({
  name: 'contacts',
  scope: 'tenant',
  decimals: ['creditLimit'],
  schema: {
    bsonType: 'object',
    required: ['name', 'isCustomer', 'isVendor', 'paymentTermsDays', 'creditHold', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1 },
      gstin: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z][0-9A-Z]$' }] },
      stateCode: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{2}$' }] },
      pan: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' }] },
      pincode: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[1-9][0-9]{5}$' }] },
      isCustomer: { bsonType: 'bool' },
      isVendor: { bsonType: 'bool' },
      paymentTermsDays: { bsonType: ['int', 'long'], minimum: 0, maximum: 3650 },
      creditLimit: { bsonType: ['decimal', 'null'] },
      creditHold: { bsonType: 'bool' },
      creditHoldReason: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', maxLength: 500 }] },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, name: 1 }, name: 'org_name' }],
  guards: {
    beforeInsert(c) {
      if (c.creditLimit !== null && c.creditLimit.startsWith('-')) throw new GuardViolation('A credit limit cannot be negative');
      checkContact(c);
    },
    afterUpdate(before, after) {
      if (after.creditLimit !== null && after.creditLimit.startsWith('-')) throw new GuardViolation('A credit limit cannot be negative');
      checkContact(after);
    },
    beforeDelete() {
      throw new GuardViolation('Contacts are kept; make them inactive instead');
    },
  },
});

export const CONTACTS: MovedTable = { def: contacts, model: 'contact' };

/** A new contact with every field set, as the PostgreSQL defaults set them. */
export function newContact(c: Partial<ContactDoc> & { name: string }, now = new Date()): Omit<ContactDoc, 'id' | 'orgId'> {
  return {
    email: null,
    phone: null,
    taxId: null,
    gstin: null,
    stateCode: null,
    pan: null,
    withholdingSectionId: null,
    address: null,
    city: null,
    pincode: null,
    isCustomer: false,
    isVendor: false,
    paymentTermsDays: 30,
    creditLimit: null,
    creditHold: false,
    creditHoldReason: null,
    creditHoldAt: null,
    creditHoldById: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...c,
  };
}
