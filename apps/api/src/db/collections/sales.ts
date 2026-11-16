import { Prisma } from '@talk2tax/database';
import { defineCollection, GuardViolation, type GuardContext } from '@talk2tax/document-db';
import type { Binary } from '@talk2tax/document-db';
import type { MovedTable } from '../moved-table';
import { checkLineDimensions, eInvoicesRef, eWayBillsRef, invoiceTemplatesRef, purchaseOrderLinesRef, purchaseOrdersRef, withholdingDepositItemsRef } from './mirrored-refs';

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

// contacts_start_customer_onboarding opens an onboarding for a new customer or vendor.
export const CONTACTS: MovedTable = { def: contacts, model: 'contact', triggers: [{ model: 'CustomerOnboarding', key: 'contactId' }] };

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

// ------------------------------------------------------------------ invoices, bills and credits

export type DocumentKindName = 'INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT';
export type DocumentStatusName = 'DRAFT' | 'POSTED' | 'VOID';

export interface DocumentLineDoc {
  id: string;
  lineNo: number;
  description: string | null;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxRateId: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
  hsnCode: string | null;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  departmentId: string | null;
  projectId: string | null;
  purchaseOrderLineId: string | null;
}

export interface DocumentDoc {
  id: string;
  orgId: string;
  kind: DocumentKindName;
  status: DocumentStatusName;
  number: string | null;
  contactId: string;
  issueDate: Date;
  dueDate: Date;
  reference: string | null;
  memo: string | null;
  currency: string;
  exchangeRate: string;
  placeOfSupply: string | null;
  supplierState: string | null;
  supplyNature: 'INTRA' | 'INTER' | null;
  counterpartyGstin: string | null;
  reverseCharge: boolean;
  reverseChargeTax: string;
  withholdingSectionId: string | null;
  withholdingKind: 'TDS' | 'TCS' | null;
  withholdingSubject: string;
  withholdingBase: string;
  withholdingRate: string;
  withholdingAmount: string;
  counterpartyPan: string | null;
  subtotal: string;
  taxTotal: string;
  total: string;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  voidDate: Date | null;
  voidReason: string | null;
  createdById: string;
  postedById: string | null;
  postedAt: Date | null;
  templateId: string | null;
  debitNoteForId: string | null;
  purchaseOrderId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: DocumentLineDoc[];
}

const n = (s: string) => new Prisma.Decimal(s);

/** Were the documents_*_chk and document_lines_*_chk constraints. */
function checkDocument(x: DocumentDoc) {
  const withheld = x.withholdingKind === 'TCS' ? n(x.withholdingAmount) : x.withholdingKind === 'TDS' ? n(x.withholdingAmount).neg() : n('0');
  if (!n(x.total).eq(n(x.subtotal).plus(x.taxTotal).plus(withheld)) || !n(x.total).gt(0) || n(x.subtotal).isNeg() || n(x.taxTotal).isNeg()) {
    throw new GuardViolation('The total must be the subtotal plus tax (and TCS, less TDS), and above zero');
  }
  if (x.dueDate < x.issueDate) throw new GuardViolation('The due date cannot be before the issue date');
  const ok =
    (x.status === 'DRAFT' && x.number === null && x.journalEntryId === null) ||
    (x.status === 'POSTED' && x.number !== null && x.journalEntryId !== null && x.voidJournalEntryId === null) ||
    (x.status === 'VOID' && x.number !== null && x.journalEntryId !== null && x.voidJournalEntryId !== null && x.voidDate !== null);
  if (!ok) throw new GuardViolation(`A ${x.status.toLowerCase()} document has the wrong number, journal or void fields`);
  const noGst = x.placeOfSupply === null && x.supplierState === null && x.supplyNature === null && x.counterpartyGstin === null;
  const gst = x.placeOfSupply !== null && x.supplierState !== null && x.supplyNature !== null && (x.supplyNature === 'INTRA') === (x.placeOfSupply === x.supplierState && x.placeOfSupply !== '96');
  if (!noGst && !gst) throw new GuardViolation('The GST place of supply, supplier state and nature of supply do not agree');
  const noTax = x.withholdingSectionId === null && x.withholdingKind === null && [x.withholdingSubject, x.withholdingBase, x.withholdingRate, x.withholdingAmount].every((v) => n(v).eq(0));
  const tax =
    x.withholdingSectionId !== null &&
    ((x.withholdingKind === 'TDS' && x.kind === 'BILL') || (x.withholdingKind === 'TCS' && x.kind === 'INVOICE')) &&
    !n(x.withholdingSubject).isNeg() && !n(x.withholdingBase).isNeg() && n(x.withholdingRate).gt(0) && n(x.withholdingRate).lte(100) && !n(x.withholdingAmount).isNeg();
  if (!noTax && !tax) throw new GuardViolation('TDS is withheld on bills and TCS collected on invoices, with a section and a rate up to 100%');
  const rc = x.reverseCharge
    ? (x.kind === 'BILL' || x.kind === 'VENDOR_CREDIT') && x.placeOfSupply !== null && n(x.taxTotal).eq(0) && !n(x.reverseChargeTax).isNeg()
    : n(x.reverseChargeTax).eq(0);
  if (!rc) throw new GuardViolation('Reverse charge is for GST purchases, with the tax kept off the total');
  if (new Set(x.lines.map((l) => l.lineNo)).size !== x.lines.length) throw new GuardViolation('Line numbers must be unique');
  for (const l of x.lines) {
    if (!n(l.quantity).gt(0) || n(l.unitPrice).isNeg() || n(l.netAmount).isNeg() || n(l.taxAmount).isNeg()) throw new GuardViolation(`Line ${l.lineNo}: the quantity must be above zero and no amount negative`);
    const [c, s, i] = [n(l.cgstAmount), n(l.sgstAmount), n(l.igstAmount)];
    const heads = c.plus(s).plus(i);
    if (c.isNeg() || s.isNeg() || i.isNeg() || !c.eq(s) || !(i.eq(0) || c.eq(0)) || !(heads.eq(0) || heads.eq(l.taxAmount))) {
      throw new GuardViolation(`Line ${l.lineNo}: CGST equals SGST, IGST is charged instead of them, and the heads add up to the tax`);
    }
  }
}

/** What a posted document may not change (t2t_guard_document); the template and updatedAt may. */
const POSTED_FIXED = [
  'kind', 'number', 'contactId', 'issueDate', 'dueDate', 'currency', 'subtotal', 'taxTotal', 'total', 'journalEntryId', 'reference',
  'placeOfSupply', 'supplierState', 'supplyNature', 'counterpartyGstin', 'reverseCharge', 'reverseChargeTax', 'withholdingSectionId', 'withholdingKind',
  'withholdingSubject', 'withholdingBase', 'withholdingRate', 'withholdingAmount', 'counterpartyPan', 'exchangeRate', 'lines', 'orgId', 'createdById',
] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const DOC_DECIMALS = ['exchangeRate', 'reverseChargeTax', 'withholdingSubject', 'withholdingBase', 'withholdingRate', 'withholdingAmount', 'subtotal', 'taxTotal', 'total'] as const;
const LINE_DECIMALS = ['quantity', 'unitPrice', 'taxRate', 'netAmount', 'taxAmount', 'cgstAmount', 'sgstAmount', 'igstAmount'] as const;
const decimalOrString = { bsonType: 'decimal' };

export const documents = defineCollection<DocumentDoc>({
  name: 'documents',
  scope: 'tenant',
  decimals: [...DOC_DECIMALS, ...LINE_DECIMALS.map((k) => `lines[].${k}`)],
  schema: {
    bsonType: 'object',
    required: ['kind', 'status', 'contactId', 'issueDate', 'dueDate', 'currency', 'exchangeRate', 'subtotal', 'taxTotal', 'total', 'createdById', 'createdAt', 'updatedAt', 'lines'],
    properties: {
      kind: { enum: ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'] },
      status: { enum: ['DRAFT', 'POSTED', 'VOID'] },
      contactId: { bsonType: 'string' },
      issueDate: { bsonType: 'date' },
      dueDate: { bsonType: 'date' },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      placeOfSupply: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{2}$' }] },
      supplierState: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[0-9]{2}$' }] },
      supplyNature: { enum: [null, 'INTRA', 'INTER'] },
      withholdingKind: { enum: [null, 'TDS', 'TCS'] },
      counterpartyPan: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' }] },
      reverseCharge: { bsonType: 'bool' },
      ...Object.fromEntries(DOC_DECIMALS.map((k) => [k, decimalOrString])),
      lines: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['id', 'lineNo', 'accountId', ...LINE_DECIMALS],
          properties: {
            id: { bsonType: 'string' },
            lineNo: { bsonType: ['int', 'long'], minimum: 1 },
            accountId: { bsonType: 'string' },
            hsnCode: { anyOf: [{ bsonType: 'null' }, { bsonType: 'string', pattern: '^([0-9]{4}|[0-9]{6}|[0-9]{8})$' }] },
            ...Object.fromEntries(LINE_DECIMALS.map((k) => [k, decimalOrString])),
          },
        },
      },
    },
  },
  indexes: [
    { key: { orgId: 1, kind: 1, number: 1 }, name: 'org_kind_number', unique: true, partialFilterExpression: { number: { $type: 'string' } } },
    { key: { journalEntryId: 1 }, name: 'journal', unique: true, partialFilterExpression: { journalEntryId: { $type: 'string' } } },
    { key: { voidJournalEntryId: 1 }, name: 'void_journal', unique: true, partialFilterExpression: { voidJournalEntryId: { $type: 'string' } } },
    { key: { orgId: 1, kind: 1, status: 1 }, name: 'org_kind_status' },
    { key: { orgId: 1, contactId: 1 }, name: 'org_contact' },
    { key: { orgId: 1, debitNoteForId: 1 }, name: 'org_debit_note_for' },
    { key: { 'lines.id': 1 }, name: 'line_id', unique: true },
  ],
  guards: {
    async beforeInsert(x, ctx) {
      if (x.status !== 'DRAFT') throw new GuardViolation('A document starts as a draft');
      checkDocument(x);
      const c = await ctx.collection(contacts).findOne({ id: x.contactId, orgId: x.orgId });
      if (!c) throw new GuardViolation('The contact does not exist in this organisation');
      await checkDocumentLinks(null, x, ctx);
    },
    async afterUpdate(before, after, ctx) {
      if (before.status === 'VOID') throw new GuardViolation('A void document is immutable');
      if (before.status === 'POSTED') {
        const changed = POSTED_FIXED.find((k) => !same(before[k], after[k]));
        if (changed || (after.status !== 'POSTED' && after.status !== 'VOID')) throw new GuardViolation('A posted document is immutable; void it and issue a new one');
        if (after.status === 'POSTED' && (after.voidDate !== before.voidDate || after.voidReason !== before.voidReason)) throw new GuardViolation('A posted document is immutable; void it and issue a new one');
      } else if (after.status === 'VOID') throw new GuardViolation('Drafts are deleted, not voided');
      if (after.orgId !== before.orgId || after.createdById !== before.createdById) throw new GuardViolation('A document keeps its organisation and author');
      checkDocument(after);
      if (before.status === 'DRAFT' && after.status === 'POSTED') await checkApprovedToPost(after, ctx);
      if (after.contactId !== before.contactId && !(await ctx.collection(contacts).findOne({ id: after.contactId, orgId: after.orgId }))) throw new GuardViolation('The contact does not exist in this organisation');
      await checkDocumentLinks(before, after, ctx);
    },
    beforeDelete(x) {
      if (x.status !== 'DRAFT') throw new GuardViolation('A posted document cannot be deleted; void it instead');
    },
  },
});

export const DOCUMENTS: MovedTable = { def: documents, model: 'document', children: { field: 'lines', model: 'documentLine', parentKey: 'documentId' } };

/** A new draft with the columns' defaults, for MovedTables.create. */
export function newDocument(x: Pick<DocumentDoc, 'kind' | 'contactId' | 'issueDate' | 'dueDate' | 'currency' | 'subtotal' | 'taxTotal' | 'total' | 'createdById'> & Partial<DocumentDoc>, now = new Date()): Omit<DocumentDoc, 'id' | 'orgId'> {
  return {
    status: 'DRAFT',
    number: null,
    reference: null,
    memo: null,
    exchangeRate: '1',
    placeOfSupply: null,
    supplierState: null,
    supplyNature: null,
    counterpartyGstin: null,
    reverseCharge: false,
    reverseChargeTax: '0',
    withholdingSectionId: null,
    withholdingKind: null,
    withholdingSubject: '0',
    withholdingBase: '0',
    withholdingRate: '0',
    withholdingAmount: '0',
    counterpartyPan: null,
    journalEntryId: null,
    voidJournalEntryId: null,
    voidDate: null,
    voidReason: null,
    postedById: null,
    postedAt: null,
    templateId: null,
    debitNoteForId: null,
    purchaseOrderId: null,
    createdAt: now,
    updatedAt: now,
    lines: [],
    ...x,
  };
}

// ------------------------------------------------------------------ receipts, payments and what they settle

export interface PaymentDoc {
  id: string;
  orgId: string;
  kind: 'RECEIPT' | 'PAYMENT';
  status: 'POSTED' | 'VOID';
  number: string;
  contactId: string;
  date: Date;
  bankAccountId: string;
  currency: string;
  exchangeRate: string;
  amount: string;
  reference: string | null;
  memo: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidDate: Date | null;
  idempotencyKey: string | null;
  idempotencyHash: string | null;
  createdById: string;
  createdAt: Date;
}

/** Was t2t_guard_payment: the only change a payment takes is being voided once. */
const PAYMENT_FIXED = ['orgId', 'kind', 'number', 'contactId', 'date', 'bankAccountId', 'currency', 'amount', 'journalEntryId', 'exchangeRate', 'createdById'] as const;

function checkPayment(p: PaymentDoc) {
  if (!n(p.amount).gt(0)) throw new GuardViolation('A payment amount must be above zero');
  if (!n(p.exchangeRate).gt(0)) throw new GuardViolation('The exchange rate must be above zero');
  if ((p.status === 'POSTED') !== (p.voidJournalEntryId === null)) throw new GuardViolation('A void payment has its reversal, and only a void one does');
}

export const payments = defineCollection<PaymentDoc>({
  name: 'payments',
  scope: 'tenant',
  decimals: ['exchangeRate', 'amount'],
  schema: {
    bsonType: 'object',
    required: ['kind', 'status', 'number', 'contactId', 'date', 'bankAccountId', 'currency', 'exchangeRate', 'amount', 'journalEntryId', 'createdById', 'createdAt'],
    properties: {
      kind: { enum: ['RECEIPT', 'PAYMENT'] },
      status: { enum: ['POSTED', 'VOID'] },
      number: { bsonType: 'string', minLength: 1 },
      date: { bsonType: 'date' },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      exchangeRate: { bsonType: 'decimal' },
      amount: { bsonType: 'decimal' },
    },
  },
  indexes: [
    { key: { orgId: 1, kind: 1, number: 1 }, name: 'org_kind_number', unique: true },
    { key: { orgId: 1, idempotencyKey: 1 }, name: 'org_idempotency', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
    { key: { journalEntryId: 1 }, name: 'journal', unique: true },
    { key: { voidJournalEntryId: 1 }, name: 'void_journal', unique: true, partialFilterExpression: { voidJournalEntryId: { $type: 'string' } } },
    { key: { orgId: 1, contactId: 1 }, name: 'org_contact' },
  ],
  guards: {
    async beforeInsert(p, ctx) {
      if (p.status !== 'POSTED') throw new GuardViolation('A payment is recorded posted');
      checkPayment(p);
      if (!(await ctx.collection(contacts).findOne({ id: p.contactId, orgId: p.orgId }))) throw new GuardViolation('The contact does not exist in this organisation');
    },
    async afterUpdate(before, after, ctx) {
      if (before.status === 'VOID' || after.status !== 'VOID' || PAYMENT_FIXED.some((k) => !same(before[k], after[k]))) throw new GuardViolation('A payment is immutable; void it instead');
      checkPayment(after);
      // Was payments_void_check.
      if (await ctx.collection(allocations).findOne({ orgId: after.orgId, paymentId: after.id, removedOn: null })) throw new GuardViolation(`Cannot void ${after.id} while allocations use it; remove them first`);
    },
    beforeDelete() {
      throw new GuardViolation('A payment cannot be deleted; void it instead');
    },
  },
});

export const PAYMENTS: MovedTable = { def: payments, model: 'payment' };

export interface AllocationDoc {
  id: string;
  orgId: string;
  targetId: string;
  paymentId: string | null;
  creditDocumentId: string | null;
  writeOffId: string | null;
  amount: string;
  date: Date;
  createdById: string;
  createdAt: Date;
  removedOn: Date | null;
  removedById: string | null;
  fxGain: string;
  fxJournalEntryId: string | null;
  fxReversalJournalEntryId: string | null;
}

/** Was t2t_guard_allocation: an allocation is never deleted, only removed once. */
const ALLOCATION_FIXED = ['orgId', 'targetId', 'paymentId', 'creditDocumentId', 'writeOffId', 'amount', 'date', 'fxGain', 'fxJournalEntryId', 'createdById'] as const;

/**
 * Was allocations_*_chk and, for what one allocation can see, t2t_check_allocation: it settles
 * a posted invoice or bill from one posted source of the same contact and currency, within
 * the source's and the target's totals. Write-offs are checked by the PostgreSQL copy until
 * bad debts move.
 */
async function checkAllocation(a: AllocationDoc, ctx: GuardContext) {
  if (!n(a.amount).gt(0)) throw new GuardViolation('An allocation amount must be above zero');
  if ([a.paymentId, a.creditDocumentId, a.writeOffId].filter((x) => x !== null).length !== 1) throw new GuardViolation('An allocation has exactly one source');
  const t = await ctx.collection(documents).findOne({ id: a.targetId, orgId: a.orgId });
  if (!t || (t.kind !== 'INVOICE' && t.kind !== 'BILL')) throw new GuardViolation('Allocations can only settle invoices or bills');
  if (a.writeOffId !== null) return;
  const source = a.paymentId !== null ? await ctx.collection(payments).findOne({ id: a.paymentId, orgId: a.orgId }) : await ctx.collection(documents).findOne({ id: a.creditDocumentId!, orgId: a.orgId });
  if (!source) throw new GuardViolation('The allocation source does not exist');
  const sourceKind = source.kind;
  const fits = t.kind === 'INVOICE' ? sourceKind === 'RECEIPT' || sourceKind === 'CREDIT_NOTE' : sourceKind === 'PAYMENT' || sourceKind === 'VENDOR_CREDIT';
  if (!fits) throw new GuardViolation('Receipts and credit notes settle invoices; payments and vendor credits settle bills');
  if (source.contactId !== t.contactId) throw new GuardViolation('Allocation source and target belong to different contacts');
  if (source.currency !== t.currency) throw new GuardViolation('An allocation links records in the same currency');
  if (t.status !== 'POSTED' || source.status !== 'POSTED') throw new GuardViolation('Allocations need posted documents and payments');
  const active = ctx.collection(allocations);
  const sum = (rows: AllocationDoc[]) => rows.reduce((s, r) => s.plus(r.amount), n('0'));
  const sourceFilter = a.paymentId !== null ? { paymentId: a.paymentId } : { creditDocumentId: a.creditDocumentId };
  // Called before the insert, so the new allocation is added to what is already there.
  const used = sum(await active.find({ orgId: a.orgId, removedOn: null, ...sourceFilter })).plus(a.amount);
  const sourceTotal = 'amount' in source ? source.amount : source.total;
  if (used.gt(sourceTotal)) throw new GuardViolation(`Allocations exceed the source amount (${used.toFixed()} > ${n(sourceTotal).toFixed()})`);
  const settled = sum(await active.find({ orgId: a.orgId, removedOn: null, targetId: a.targetId })).plus(a.amount);
  if (settled.gt(t.total)) throw new GuardViolation(`Allocations exceed the document total (${settled.toFixed()} > ${n(t.total).toFixed()})`);
}

export const allocations = defineCollection<AllocationDoc>({
  name: 'allocations',
  scope: 'tenant',
  decimals: ['amount', 'fxGain'],
  schema: {
    bsonType: 'object',
    required: ['targetId', 'amount', 'date', 'createdById', 'createdAt', 'fxGain'],
    properties: {
      targetId: { bsonType: 'string' },
      amount: { bsonType: 'decimal' },
      fxGain: { bsonType: 'decimal' },
      date: { bsonType: 'date' },
    },
  },
  indexes: [
    { key: { orgId: 1, targetId: 1 }, name: 'org_target' },
    { key: { orgId: 1, paymentId: 1 }, name: 'org_payment' },
    { key: { orgId: 1, creditDocumentId: 1 }, name: 'org_credit_document' },
    { key: { orgId: 1, writeOffId: 1 }, name: 'org_write_off' },
    { key: { fxJournalEntryId: 1 }, name: 'fx_journal', unique: true, partialFilterExpression: { fxJournalEntryId: { $type: 'string' } } },
    { key: { fxReversalJournalEntryId: 1 }, name: 'fx_reversal_journal', unique: true, partialFilterExpression: { fxReversalJournalEntryId: { $type: 'string' } } },
  ],
  guards: {
    async beforeInsert(a, ctx) {
      if (a.removedOn !== null) throw new GuardViolation('An allocation starts active');
      await checkAllocation(a, ctx);
    },
    afterUpdate(before, after) {
      if (before.removedOn !== null || after.removedOn === null || ALLOCATION_FIXED.some((k) => !same(before[k], after[k])) || (before.fxJournalEntryId !== null && after.fxReversalJournalEntryId === null)) {
        throw new GuardViolation('An allocation is immutable apart from being removed once');
      }
    },
    beforeDelete() {
      throw new GuardViolation('An allocation cannot be deleted; remove it instead');
    },
  },
});

export const ALLOCATIONS: MovedTable = { def: allocations, model: 'allocation' };

/** A new active allocation with the columns' defaults, for MovedTables.create. */
export function newAllocation(a: Pick<AllocationDoc, 'targetId' | 'amount' | 'date' | 'createdById'> & Partial<AllocationDoc>, now = new Date()): Omit<AllocationDoc, 'id' | 'orgId'> {
  return { paymentId: null, creditDocumentId: null, writeOffId: null, createdAt: now, removedOn: null, removedById: null, fxGain: '0', fxJournalEntryId: null, fxReversalJournalEntryId: null, ...a };
}

// ------------------------------------------------------------------ approvals

export interface ApprovalPolicyDoc {
  id: string;
  orgId: string;
  documentKind: DocumentKindName;
  minAmount: string;
  requireDifferentApprover: boolean;
  isActive: boolean;
  updatedById: string;
  createdAt: Date;
  updatedAt: Date;
}

export const approvalPolicies = defineCollection<ApprovalPolicyDoc>({
  name: 'approval_policies',
  scope: 'tenant',
  decimals: ['minAmount'],
  schema: {
    bsonType: 'object',
    required: ['documentKind', 'minAmount', 'requireDifferentApprover', 'isActive', 'updatedById', 'createdAt', 'updatedAt'],
    properties: { documentKind: { enum: ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'] }, minAmount: { bsonType: 'decimal' }, isActive: { bsonType: 'bool' } },
  },
  indexes: [{ key: { orgId: 1, documentKind: 1 }, name: 'org_kind', unique: true }],
  guards: {
    beforeInsert(p) {
      if (n(p.minAmount).isNeg()) throw new GuardViolation('The minimum amount cannot be negative');
    },
    afterUpdate(before, after) {
      if (n(after.minAmount).isNeg()) throw new GuardViolation('The minimum amount cannot be negative');
      if (after.documentKind !== before.documentKind || after.orgId !== before.orgId) throw new GuardViolation('A policy keeps its document type');
    },
  },
});

export const APPROVAL_POLICIES: MovedTable = { def: approvalPolicies, model: 'approvalPolicy' };

export type ApprovalStatusName = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface ApprovalRequestDoc {
  id: string;
  orgId: string;
  documentId: string | null;
  documentKind: DocumentKindName;
  contactName: string;
  total: string;
  status: ApprovalStatusName;
  note: string | null;
  requestedById: string;
  requestedAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

/** Were approval_requests_total_chk and approval_requests_decided_chk. */
function checkRequest(r: ApprovalRequestDoc) {
  if (!n(r.total).gt(0)) throw new GuardViolation('An approval request total must be above zero');
  if ((r.status === 'PENDING') !== (r.decidedAt === null)) throw new GuardViolation('A decided request has its decision time, and only a decided one does');
}

export const approvalRequests = defineCollection<ApprovalRequestDoc>({
  name: 'approval_requests',
  scope: 'tenant',
  decimals: ['total'],
  schema: {
    bsonType: 'object',
    required: ['documentKind', 'contactName', 'total', 'status', 'requestedById', 'requestedAt'],
    properties: { status: { enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] }, total: { bsonType: 'decimal' } },
  },
  indexes: [
    { key: { orgId: 1, status: 1 }, name: 'org_status' },
    { key: { documentId: 1 }, name: 'document' },
  ],
  // Was t2t_guard_approval_request.
  guards: {
    async beforeInsert(r, ctx) {
      const d = r.documentId ? await ctx.collection(documents).findOne({ id: r.documentId, orgId: r.orgId }) : null;
      if (!d || d.status !== 'DRAFT' || r.status !== 'PENDING') throw new GuardViolation('Approval can only be requested for a draft in the same organisation');
      checkRequest(r);
      // Was approval_requests_open_uniq: at most one open (pending or approved) request per document.
      if (await ctx.collection(approvalRequests).exists({ documentId: r.documentId, status: { $in: ['PENDING', 'APPROVED'] } })) throw new GuardViolation('This document already has an open approval request');
    },
    async afterUpdate(before, after, ctx) {
      // Deleting the draft clears documentId; nothing else may change on that path.
      if (after.documentId !== before.documentId && !(after.documentId === null && after.status === before.status)) throw new GuardViolation('An approval request cannot be moved to another document');
      if (after.orgId !== before.orgId || !n(after.total).eq(before.total) || after.requestedById !== before.requestedById || after.documentKind !== before.documentKind) throw new GuardViolation('An approval request cannot be changed');
      if (after.status !== before.status) {
        const ok = (before.status === 'PENDING' && ['APPROVED', 'REJECTED', 'CANCELLED'].includes(after.status)) || (before.status === 'APPROVED' && after.status === 'CANCELLED');
        if (!ok) throw new GuardViolation(`An approval request cannot go from ${before.status} to ${after.status}`);
        if (after.status === 'APPROVED') {
          const d = after.documentId ? await ctx.collection(documents).findOne({ id: after.documentId, orgId: after.orgId }) : null;
          if (!d || d.status !== 'DRAFT') throw new GuardViolation('The request is for a document that is no longer a draft');
          const p = await ctx.collection(approvalPolicies).findOne({ orgId: after.orgId, documentKind: after.documentKind });
          if ((p?.requireDifferentApprover ?? true) && (after.decidedById === after.requestedById || after.decidedById === d.createdById)) throw new GuardViolation('The request must be approved by someone other than its author and requester');
        }
      } else if (before.status !== 'PENDING' && (after.decidedById !== before.decidedById || +(after.decidedAt ?? 0) !== +(before.decidedAt ?? 0) || after.decisionNote !== before.decisionNote)) {
        throw new GuardViolation('An approval decision cannot be changed');
      }
      checkRequest(after);
    },
    beforeDelete() {
      throw new GuardViolation('Approval requests are kept');
    },
  },
});

export const APPROVAL_REQUESTS: MovedTable = { def: approvalRequests, model: 'approvalRequest' };

/** Was t2t_check_document_approval: a document covered by an active policy posts only with an approval for exactly its total. */
async function checkApprovedToPost(x: DocumentDoc, ctx: GuardContext) {
  const p = await ctx.collection(approvalPolicies).findOne({ orgId: x.orgId, documentKind: x.kind, isActive: true });
  if (!p || n(x.total).lt(p.minAmount)) return;
  const approved = await ctx.collection(approvalRequests).find({ orgId: x.orgId, documentId: x.id, status: 'APPROVED' });
  if (!approved.some((r) => n(r.total).eq(x.total))) throw new GuardViolation('This document needs an approval before it can post');
}

/**
 * Were documents_debit_note_check, documents_po_check, documents_template_check, the line
 * checks document_lines_dimensions and document_lines_po_check, and what voiding needs first
 * (documents_void_check, documents_void_debit_notes_check, documents_ewb_guard,
 * documents_irn_guard, documents_void_deposited_check).
 */
async function checkDocumentLinks(before: DocumentDoc | null, x: DocumentDoc, ctx: GuardContext) {
  const docs = ctx.collection(documents);
  if (before && before.status !== 'DRAFT' && before.debitNoteForId !== x.debitNoteForId) throw new GuardViolation('The invoice a posted debit note adjusts cannot change');
  if (
    x.debitNoteForId !== null &&
    x.status !== 'VOID' &&
    (!before || before.status !== x.status || before.debitNoteForId !== x.debitNoteForId || before.contactId !== x.contactId || before.currency !== x.currency)
  ) {
    const o = await docs.findOne({ id: x.debitNoteForId, orgId: x.orgId });
    if (o) {
      if (o.kind !== 'INVOICE' || o.debitNoteForId !== null) throw new GuardViolation('A debit note adjusts an invoice, not another debit note or a credit note');
      if (o.status !== 'POSTED') throw new GuardViolation('A debit note can only adjust a posted invoice');
      if (o.contactId !== x.contactId || o.currency !== x.currency) throw new GuardViolation('A debit note must be to the same customer and in the same currency as its invoice');
    }
  }
  if (x.purchaseOrderId !== null && (!before || before.purchaseOrderId !== x.purchaseOrderId || before.contactId !== x.contactId)) {
    if (x.kind !== 'BILL' || !(await ctx.collection(await purchaseOrdersRef()).findOne({ id: x.purchaseOrderId, orgId: x.orgId, contactId: x.contactId }))) {
      throw new GuardViolation('A bill is matched only to a purchase order of the same vendor');
    }
  }
  if (x.templateId !== null && x.templateId !== (before?.templateId ?? null)) {
    if (x.kind !== 'INVOICE' && x.kind !== 'CREDIT_NOTE') throw new GuardViolation('Only invoices and credit notes have a print template');
    if (await ctx.collection(await invoiceTemplatesRef()).findOne({ id: x.templateId, orgId: x.orgId, archivedAt: { $ne: null } })) throw new GuardViolation(`Template ${x.templateId} is archived`);
  }
  await checkLineDimensions(x.orgId, x.lines, before?.lines ?? null, ctx);
  const was = new Map((before?.lines ?? []).map((l) => [l.id, l]));
  for (const l of x.lines) {
    if (l.purchaseOrderLineId === null || was.get(l.id)?.purchaseOrderLineId === l.purchaseOrderLineId) continue;
    const pol = await ctx.collection(await purchaseOrderLinesRef()).findOne({ id: l.purchaseOrderLineId, orgId: x.orgId });
    const po = pol ? await ctx.collection(await purchaseOrdersRef()).findOne({ id: pol.orderId as string, orgId: x.orgId }) : null;
    if (!po || x.kind !== 'BILL' || x.purchaseOrderId !== po.id || x.contactId !== po.contactId || po.status === 'DRAFT') {
      throw new GuardViolation('A bill line is billed only against an issued purchase order of the same vendor');
    }
  }
  if (!before || before.status === 'VOID' || x.status !== 'VOID') return;
  const live = { orgId: x.orgId, documentId: x.id, status: 'ACTIVE' };
  if (await ctx.collection(await eWayBillsRef()).findOne(live)) throw new GuardViolation(`Document ${before.number} has a live e-way bill; cancel it on the portal first`);
  if (await ctx.collection(await eInvoicesRef()).findOne(live)) throw new GuardViolation(`Document ${before.number} has an IRN; cancel the IRN first or issue a credit note`);
  if (await ctx.collection(allocations).findOne({ orgId: x.orgId, removedOn: null, $or: [{ targetId: x.id }, { creditDocumentId: x.id }] })) throw new GuardViolation(`Cannot void ${x.id} while allocations use it; remove them first`);
  if (before.status === 'POSTED') {
    if (await docs.findOne({ orgId: x.orgId, debitNoteForId: x.id, status: { $ne: 'VOID' } })) throw new GuardViolation(`Invoice ${x.id} has debit notes; void them first`);
    if (await ctx.collection(await withholdingDepositItemsRef()).findOne({ orgId: x.orgId, documentId: x.id, active: true })) throw new GuardViolation(`Document ${x.id} has withheld tax in a deposit; void the deposit first`);
  }
}

// ------------------------------------------------------------------ attachments

export type AttachmentEntityName = 'DOCUMENT' | 'PAYMENT' | 'JOURNAL_ENTRY' | 'BANK_STATEMENT_LINE' | 'EXPENSE_CLAIM' | 'CUSTOMER_ONBOARDING';
export const ATTACHMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

export interface AttachmentDoc {
  id: string;
  orgId: string;
  entityType: AttachmentEntityName;
  entityId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  /** The file's bytes (BSON binary; files are at most 5 MB). */
  content: Binary | Buffer;
  uploadedById: string;
  createdAt: Date;
  removedAt: Date | null;
  removedById: string | null;
  removedReason: string | null;
}

// A Uint8Array (as Prisma returns Bytes) can be a view on a larger buffer, so it is read by its own offset and length.
const bytesOf = (c: Binary | Buffer | Uint8Array) => (Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c.buffer, c.byteOffset, c.byteLength) : Buffer.from(c.buffer));

/** Were attachments_*_chk. */
function checkAttachment(a: AttachmentDoc) {
  const size = bytesOf(a.content).length;
  if (a.sizeBytes <= 0 || a.sizeBytes > 5 * 1024 * 1024 || a.sizeBytes !== size) throw new GuardViolation('An attachment is 1 byte to 5 MB, and its size is its content');
  if ((a.removedAt === null) !== (a.removedReason === null)) throw new GuardViolation('A removed attachment says why');
}

export const attachments = defineCollection<AttachmentDoc>({
  name: 'attachments',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['entityType', 'entityId', 'fileName', 'contentType', 'sizeBytes', 'sha256', 'content', 'uploadedById', 'createdAt'],
    properties: {
      entityType: { enum: ['DOCUMENT', 'PAYMENT', 'JOURNAL_ENTRY', 'BANK_STATEMENT_LINE', 'EXPENSE_CLAIM', 'CUSTOMER_ONBOARDING'] },
      contentType: { enum: ATTACHMENT_TYPES },
      sha256: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      sizeBytes: { bsonType: ['int', 'long'] },
      content: { bsonType: 'binData' },
    },
  },
  indexes: [{ key: { orgId: 1, entityType: 1, entityId: 1 }, name: 'org_entity' }],
  // Was t2t_guard_attachment: the bytes never change, and removal happens once.
  guards: {
    beforeInsert(a) {
      checkAttachment(a);
    },
    afterUpdate(before, after) {
      const fixed = (['sha256', 'sizeBytes', 'fileName', 'contentType', 'entityType', 'entityId', 'orgId'] as const).some((k) => after[k] !== before[k]);
      const removedAgain = before.removedAt !== null && (+before.removedAt !== +(after.removedAt ?? 0) || after.removedReason !== before.removedReason);
      if (fixed || !bytesOf(after.content).equals(bytesOf(before.content)) || removedAgain) throw new GuardViolation('An attachment cannot be changed');
      checkAttachment(after);
    },
    beforeDelete() {
      throw new GuardViolation('An attachment cannot be deleted; remove it instead');
    },
  },
});

export const ATTACHMENTS: MovedTable = { def: attachments, model: 'attachment', toRow: (d) => ({ ...d, content: new Uint8Array(bytesOf(d.content as Binary | Buffer)) }) };
