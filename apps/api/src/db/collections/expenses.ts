import { Prisma } from '@talk2tax/database';
import { defineCollection, GuardViolation } from '@talk2tax/document-db';
import type { MovedTable } from '../moved-table';

/** Employees' expense claims, with their lines inside them. */

export type ExpenseClaimStatusName = 'DRAFT' | 'SUBMITTED' | 'REJECTED' | 'APPROVED' | 'REIMBURSED' | 'VOID';

export interface ExpenseClaimLineDoc {
  id: string;
  lineNo: number;
  date: Date;
  accountId: string;
  merchant: string | null;
  description: string | null;
  amount: string;
  taxRateId: string | null;
  taxRate: string;
  netAmount: string;
  taxAmount: string;
}

export interface ExpenseClaimDoc {
  id: string;
  orgId: string;
  number: string;
  claimantId: string;
  title: string;
  currency: string;
  status: ExpenseClaimStatusName;
  netTotal: string;
  taxTotal: string;
  total: string;
  submittedAt: Date | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  journalEntryId: string | null;
  postingDate: Date | null;
  reimbursementJournalEntryId: string | null;
  reimbursedOn: Date | null;
  reimbursedById: string | null;
  bankAccountId: string | null;
  reimbursementReference: string | null;
  voidJournalEntryId: string | null;
  voidDate: Date | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: ExpenseClaimLineDoc[];
}

const n = (s: string) => new Prisma.Decimal(s);
const POSTED: ExpenseClaimStatusName[] = ['APPROVED', 'REIMBURSED', 'VOID'];
const EDITABLE: ExpenseClaimStatusName[] = ['DRAFT', 'REJECTED'];
const MOVES: Record<ExpenseClaimStatusName, ExpenseClaimStatusName[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['DRAFT', 'REJECTED', 'APPROVED'],
  REJECTED: ['DRAFT', 'SUBMITTED'],
  APPROVED: ['REIMBURSED', 'VOID'],
  REIMBURSED: [],
  VOID: [],
};

/** Were expense_claims_*_chk and expense_claim_lines_*_chk. */
function checkClaim(c: ExpenseClaimDoc) {
  if (!n(c.total).eq(n(c.netTotal).plus(c.taxTotal)) || n(c.total).isNeg() || n(c.netTotal).isNeg() || n(c.taxTotal).isNeg()) throw new GuardViolation('The claim total must be its net plus tax, none negative');
  const title = c.title.trim().length;
  if (title < 1 || title > 200) throw new GuardViolation('A claim title is 1 to 200 characters');
  const posted = POSTED.includes(c.status);
  if (posted !== (c.journalEntryId !== null && c.postingDate !== null && c.decidedById !== null)) throw new GuardViolation('An approved claim has its journal, posting date and approver, and only an approved one does');
  if ((c.status === 'REIMBURSED') !== (c.reimbursementJournalEntryId !== null && c.reimbursedOn !== null && c.bankAccountId !== null)) throw new GuardViolation('A reimbursed claim has its payment journal, date and bank');
  if ((c.status === 'VOID') !== (c.voidJournalEntryId !== null && c.voidReason !== null)) throw new GuardViolation('A void claim has its reversal and reason');
  if (c.status !== 'DRAFT' && c.submittedAt === null) throw new GuardViolation('A claim past draft has been submitted');
  if (c.status === 'REJECTED' && (c.decidedById === null || c.decisionNote === null)) throw new GuardViolation('A rejected claim says who rejected it and why');
  if (new Set(c.lines.map((l) => l.lineNo)).size !== c.lines.length) throw new GuardViolation('Line numbers must be unique');
  for (const l of c.lines) {
    if (!n(l.amount).gt(0) || n(l.taxAmount).isNeg() || n(l.netAmount).isNeg() || !n(l.amount).eq(n(l.netAmount).plus(l.taxAmount))) throw new GuardViolation(`Line ${l.lineNo}: the amount is above zero and is its net plus tax`);
    if (n(l.taxRate).isNeg() || n(l.taxRate).gt(100)) throw new GuardViolation(`Line ${l.lineNo}: the tax rate is 0 to 100%`);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const expenseClaims = defineCollection<ExpenseClaimDoc>({
  name: 'expense_claims',
  scope: 'tenant',
  decimals: ['netTotal', 'taxTotal', 'total', 'lines[].amount', 'lines[].taxRate', 'lines[].netAmount', 'lines[].taxAmount'],
  schema: {
    bsonType: 'object',
    required: ['number', 'claimantId', 'title', 'currency', 'status', 'netTotal', 'taxTotal', 'total', 'createdAt', 'updatedAt', 'lines'],
    properties: {
      number: { bsonType: 'string', minLength: 1 },
      currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      status: { enum: ['DRAFT', 'SUBMITTED', 'REJECTED', 'APPROVED', 'REIMBURSED', 'VOID'] },
      netTotal: { bsonType: 'decimal' },
      taxTotal: { bsonType: 'decimal' },
      total: { bsonType: 'decimal' },
      lines: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['id', 'lineNo', 'date', 'accountId', 'amount', 'taxRate', 'netAmount', 'taxAmount'],
          properties: { id: { bsonType: 'string' }, lineNo: { bsonType: ['int', 'long'], minimum: 1 }, date: { bsonType: 'date' }, amount: { bsonType: 'decimal' } },
        },
      },
    },
  },
  indexes: [
    { key: { orgId: 1, number: 1 }, name: 'org_number', unique: true },
    { key: { orgId: 1, status: 1 }, name: 'org_status' },
    { key: { orgId: 1, claimantId: 1 }, name: 'org_claimant' },
    { key: { journalEntryId: 1 }, name: 'journal', unique: true, partialFilterExpression: { journalEntryId: { $type: 'string' } } },
    { key: { reimbursementJournalEntryId: 1 }, name: 'reimbursement_journal', unique: true, partialFilterExpression: { reimbursementJournalEntryId: { $type: 'string' } } },
    { key: { voidJournalEntryId: 1 }, name: 'void_journal', unique: true, partialFilterExpression: { voidJournalEntryId: { $type: 'string' } } },
    { key: { 'lines.id': 1 }, name: 'line_id', unique: true },
  ],
  guards: {
    beforeInsert(c) {
      if (c.status !== 'DRAFT') throw new GuardViolation('A claim starts as a draft');
      checkClaim(c);
    },
    // Was t2t_guard_expense_claim and t2t_guard_expense_claim_line.
    afterUpdate(before, after) {
      if (after.orgId !== before.orgId || after.number !== before.number || after.claimantId !== before.claimantId || after.currency !== before.currency) throw new GuardViolation(`Expense claim ${before.number} cannot be moved or renumbered`);
      if (!EDITABLE.includes(before.status) && (after.title !== before.title || after.total !== before.total || after.netTotal !== before.netTotal || after.taxTotal !== before.taxTotal || !same(after.lines, before.lines))) {
        throw new GuardViolation(`Expense claim ${before.number} can only be edited as a draft`);
      }
      if (after.status !== before.status) {
        if (!MOVES[before.status].includes(after.status)) throw new GuardViolation(`Expense claim ${before.number} cannot go from ${before.status} to ${after.status}`);
        if (after.status === 'SUBMITTED' && (!after.lines.length || !after.lines.reduce((s, l) => s.plus(l.amount), n('0')).eq(after.total))) throw new GuardViolation(`Expense claim ${before.number} does not add up to its lines`);
        if (after.status === 'APPROVED' && after.decidedById === after.claimantId) throw new GuardViolation(`Expense claim ${before.number} must be approved by someone other than the claimant`);
      } else if (POSTED.includes(before.status) && (['decidedById', 'journalEntryId', 'reimbursementJournalEntryId', 'voidJournalEntryId'] as const).some((k) => after[k] !== before[k])) {
        throw new GuardViolation(`Expense claim ${before.number} cannot be changed`);
      }
      checkClaim(after);
    },
    beforeDelete(c) {
      if (c.status !== 'DRAFT') throw new GuardViolation(`Expense claim ${c.number} cannot be deleted unless it is a draft`);
    },
  },
});

export const EXPENSE_CLAIMS: MovedTable = { def: expenseClaims, model: 'expenseClaim', children: { field: 'lines', model: 'expenseClaimLine', parentKey: 'claimId' } };
