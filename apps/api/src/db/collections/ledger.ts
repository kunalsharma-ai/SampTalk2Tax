import { Prisma } from '@talk2tax/database';
import { defineCollection, GuardViolation, type GuardContext } from '@talk2tax/document-db';
import { accounts, fiscalPeriods } from './chart';
import { checkLineDimensions } from './mirrored-refs';
import { organizations } from './tenancy';

/** The general ledger: journal entries with their lines inside them. */

export type JournalStatusName = 'DRAFT' | 'POSTED';

export interface JournalLineDoc {
  id: string;
  lineNo: number;
  accountId: string;
  currency: string;
  /** Decimal strings. */
  exchangeRate: string;
  debit: string;
  credit: string;
  functionalDebit: string;
  functionalCredit: string;
  description: string | null;
  dimensions: Record<string, string> | null;
  departmentId: string | null;
  projectId: string | null;
}

export interface JournalEntryDoc {
  id: string;
  orgId: string;
  entryNumber: number | null;
  /** UTC midnight (PostgreSQL `date`). */
  date: Date;
  periodId: string;
  type: string;
  source: string;
  status: JournalStatusName;
  memo: string | null;
  reference: string | null;
  functionalCurrency: string;
  totalDebit: string;
  totalCredit: string;
  idempotencyKey: string | null;
  idempotencyHash: string | null;
  reversesEntryId: string | null;
  createdById: string;
  postedById: string | null;
  postedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: JournalLineDoc[];
}

const d = (s: string) => new Prisma.Decimal(s);

/** Was journal_lines_amounts_chk and the deferred t2t_check_entry_balanced trigger. */
function checkLines(e: JournalEntryDoc) {
  for (const l of e.lines) {
    const [debit, credit, fd, fc, rate] = [d(l.debit), d(l.credit), d(l.functionalDebit), d(l.functionalCredit), d(l.exchangeRate)];
    const oneSide = (debit.gt(0) && credit.eq(0)) || (credit.gt(0) && debit.eq(0));
    if (debit.isNeg() || credit.isNeg() || fd.isNeg() || fc.isNeg() || !oneSide || (!fd.eq(0) && !debit.gt(0)) || (!fc.eq(0) && !credit.gt(0)) || !rate.gt(0)) {
      throw new GuardViolation(`Line ${l.lineNo} amounts are invalid: one side positive, none negative, a positive rate`);
    }
  }
  if (new Set(e.lines.map((l) => l.lineNo)).size !== e.lines.length) throw new GuardViolation('Line numbers must be unique');
  if (e.status !== 'POSTED') return;
  if (e.entryNumber === null || e.postedAt === null || e.postedById === null) throw new GuardViolation('A posted entry needs its number, time and poster');
  if (e.lines.length < 2) throw new GuardViolation('A posted journal entry must have at least two lines');
  const debit = e.lines.reduce((s, l) => s.plus(l.functionalDebit), d('0'));
  const credit = e.lines.reduce((s, l) => s.plus(l.functionalCredit), d('0'));
  if (!debit.eq(credit)) throw new GuardViolation(`The entry does not balance (debits ${debit.toFixed()}, credits ${credit.toFixed()})`);
  if (!debit.gt(0)) throw new GuardViolation('A posted entry must move an amount');
  if (!debit.eq(e.totalDebit) || !credit.eq(e.totalCredit)) throw new GuardViolation('The header totals do not match the lines');
}

/** Was t2t_guard_journal_entry (period) and t2t_check_line_account (postable, active accounts). */
async function checkReferences(e: JournalEntryDoc, ctx: GuardContext) {
  const p = await ctx.collection(fiscalPeriods).findOne({ id: e.periodId, orgId: e.orgId });
  if (!p) throw new GuardViolation('The fiscal period does not exist');
  if (e.status === 'POSTED' && p.status !== 'OPEN') throw new GuardViolation(`Cannot post into a ${p.status} period`);
  if (e.date < p.startDate || e.date > p.endDate) throw new GuardViolation('The entry date is outside its fiscal period');
  const ids = [...new Set(e.lines.map((l) => l.accountId))];
  const found = await ctx.collection(accounts).find({ orgId: e.orgId, id: { $in: ids } });
  if (found.length !== ids.length) throw new GuardViolation('A line names an account that does not exist in this organisation');
  // Reversals may use accounts deactivated since (the service allows that for them too).
  const bad = found.find((a) => !a.isPostable || (!a.isActive && e.reversesEntryId === null));
  if (bad) throw new GuardViolation(`Account ${bad.code} is not postable or inactive`);
}

/**
 * Was journal_lines_control_account_check: manual and bank journals keep off the receivables,
 * payables and employee reimbursements control accounts (new or changed lines only).
 */
async function checkControlAccounts(e: JournalEntryDoc, before: JournalEntryDoc | null, ctx: GuardContext) {
  if (e.source !== 'MANUAL' && e.source !== 'BANK') return;
  const was = new Map((before?.lines ?? []).map((l) => [l.id, l.accountId]));
  const lines = e.lines.filter((l) => was.get(l.id) !== l.accountId);
  if (!lines.length) return;
  const o = await ctx.collection(organizations).findOne({ id: e.orgId });
  for (const l of lines) {
    if (l.accountId === o?.arAccountId || l.accountId === o?.apAccountId) throw new GuardViolation(`Account ${l.accountId} is a receivables/payables control account; Cannot post a manual journal to it`);
    if (l.accountId === o?.claimsAccountId) throw new GuardViolation(`Account ${l.accountId} holds amounts owed to employees; Cannot post a manual journal to it, use an expense claim`);
  }
}

export const journalEntries = defineCollection<JournalEntryDoc>({
  name: 'journal_entries',
  scope: 'tenant',
  decimals: ['totalDebit', 'totalCredit', 'lines[].exchangeRate', 'lines[].debit', 'lines[].credit', 'lines[].functionalDebit', 'lines[].functionalCredit'],
  schema: {
    bsonType: 'object',
    required: ['date', 'periodId', 'type', 'source', 'status', 'functionalCurrency', 'totalDebit', 'totalCredit', 'createdById', 'createdAt', 'updatedAt', 'lines'],
    properties: {
      entryNumber: { bsonType: ['int', 'long', 'null'] },
      date: { bsonType: 'date' },
      periodId: { bsonType: 'string' },
      type: { enum: ['STANDARD', 'ADJUSTING', 'OPENING', 'CLOSING', 'RECURRING', 'REVERSING'] },
      source: { bsonType: 'string', pattern: '^[A-Z_]+$' },
      status: { enum: ['DRAFT', 'POSTED'] },
      functionalCurrency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
      totalDebit: { bsonType: 'decimal' },
      totalCredit: { bsonType: 'decimal' },
      reversesEntryId: { bsonType: ['string', 'null'] },
      lines: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['id', 'lineNo', 'accountId', 'currency', 'exchangeRate', 'debit', 'credit', 'functionalDebit', 'functionalCredit'],
          properties: {
            id: { bsonType: 'string' },
            lineNo: { bsonType: ['int', 'long'], minimum: 1 },
            accountId: { bsonType: 'string' },
            currency: { bsonType: 'string', pattern: '^[A-Z]{3}$' },
            exchangeRate: { bsonType: 'decimal' },
            debit: { bsonType: 'decimal' },
            credit: { bsonType: 'decimal' },
            functionalDebit: { bsonType: 'decimal' },
            functionalCredit: { bsonType: 'decimal' },
          },
        },
      },
    },
  },
  indexes: [
    { key: { orgId: 1, entryNumber: 1 }, name: 'org_number', unique: true, partialFilterExpression: { entryNumber: { $type: 'number' } } },
    { key: { orgId: 1, idempotencyKey: 1 }, name: 'org_idempotency', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
    { key: { reversesEntryId: 1 }, name: 'reverses', unique: true, partialFilterExpression: { reversesEntryId: { $type: 'string' } } },
    { key: { orgId: 1, date: -1 }, name: 'org_date' },
    { key: { orgId: 1, status: 1 }, name: 'org_status' },
    { key: { orgId: 1, 'lines.accountId': 1 }, name: 'org_line_account' },
    { key: { 'lines.id': 1 }, name: 'line_id', unique: true },
  ],
  guards: {
    async beforeInsert(e, ctx) {
      checkLines(e);
      await checkReferences(e, ctx);
      await checkControlAccounts(e, null, ctx);
      await checkLineDimensions(e.orgId, e.lines, null, ctx);
    },
    async afterUpdate(before, after, ctx) {
      // The line checks first, as PostgreSQL's line triggers ran in name order before journal_lines_guard.
      await checkControlAccounts(after, before, ctx);
      await checkLineDimensions(after.orgId, after.lines, before.lines, ctx);
      // Was t2t_guard_journal_entry, t2t_guard_journal_line and t2t_guard_closing_type.
      if (before.status === 'POSTED') throw new GuardViolation('A posted journal entry is immutable; post a reversal or adjustment instead');
      if (after.orgId !== before.orgId || after.createdById !== before.createdById) throw new GuardViolation('An entry keeps its organisation and author');
      checkLines(after);
      await checkReferences(after, ctx);
    },
    beforeDelete(e) {
      if (e.status === 'POSTED') throw new GuardViolation('A posted journal entry cannot be deleted; post a reversal instead');
    },
  },
});
