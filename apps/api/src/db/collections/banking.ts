import { Prisma } from '@talk2tax/database';
import { defineCollection, GuardViolation, type GuardContext } from '@talk2tax/document-db';
import type { MovedTable } from '../moved-table';
import { journalEntries } from './ledger';

/** Bank statements, matching statement lines to the ledger, and reconciliations. */

export interface BankStatementImportDoc {
  id: string;
  orgId: string;
  accountId: string;
  fileName: string;
  fileHash: string;
  lineCount: number;
  skippedCount: number;
  firstDate: Date;
  lastDate: Date;
  importedById: string;
  createdAt: Date;
}

export const bankStatementImports = defineCollection<BankStatementImportDoc>({
  name: 'bank_statement_imports',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['accountId', 'fileName', 'fileHash', 'lineCount', 'skippedCount', 'firstDate', 'lastDate', 'importedById', 'createdAt'],
    properties: { lineCount: { bsonType: ['int', 'long'], minimum: 0 }, skippedCount: { bsonType: ['int', 'long'], minimum: 0 }, firstDate: { bsonType: 'date' }, lastDate: { bsonType: 'date' } },
  },
  indexes: [{ key: { orgId: 1, accountId: 1 }, name: 'org_account' }],
  guards: {
    beforeInsert(i) {
      if (i.firstDate > i.lastDate) throw new GuardViolation('An import covers its first date to its last');
    },
    afterUpdate() {
      throw new GuardViolation('A statement import is kept as it was');
    },
    beforeDelete() {
      throw new GuardViolation('A statement import is kept as it was');
    },
  },
});

export const BANK_IMPORTS: MovedTable = { def: bankStatementImports, model: 'bankStatementImport' };

export type StatementLineStatusName = 'UNMATCHED' | 'MATCHED' | 'EXCLUDED';

export interface BankStatementLineDoc {
  id: string;
  orgId: string;
  accountId: string;
  importId: string;
  date: Date;
  description: string;
  reference: string | null;
  /** Positive = money in, negative = out. */
  amount: string;
  fingerprint: string;
  status: StatementLineStatusName;
  excludedReason: string | null;
  reconciliationId: string | null;
  createdAt: Date;
}

const n = (s: string) => new Prisma.Decimal(s);

function checkLine(l: BankStatementLineDoc) {
  if (n(l.amount).eq(0)) throw new GuardViolation('A statement line moves money');
  if ((l.status === 'EXCLUDED') !== (l.excludedReason !== null)) throw new GuardViolation('An excluded line says why, and only an excluded one does');
}

/**
 * Was t2t_check_statement_line_matches: a MATCHED line's active matches are posted ledger
 * lines on the same bank account whose net equals the statement amount; other lines have none.
 */
async function checkMatches(l: BankStatementLineDoc, ctx: GuardContext) {
  const active = await ctx.collection(bankMatches).find({ orgId: l.orgId, statementLineId: l.id, removedAt: null });
  if (l.status !== 'MATCHED') {
    if (active.length) throw new GuardViolation(`The statement line has matches but is ${l.status.toLowerCase()}`);
    return;
  }
  const ids = active.map((m) => m.journalLineId);
  const entries = ids.length ? await ctx.collection(journalEntries).find({ orgId: l.orgId, 'lines.id': { $in: ids } }) : [];
  let net = n('0');
  let found = 0;
  for (const e of entries) {
    for (const jl of e.lines) {
      if (!ids.includes(jl.id)) continue;
      found++;
      if (jl.accountId !== l.accountId || e.status !== 'POSTED') throw new GuardViolation('The statement line is matched to a ledger line on a different account or not posted');
      net = net.plus(jl.functionalDebit).minus(jl.functionalCredit);
    }
  }
  if (!found || found !== ids.length || !net.eq(l.amount)) throw new GuardViolation(`The statement line amount ${n(l.amount).toFixed()} does not equal its matched ledger lines ${net.toFixed()}`);
}

export const bankStatementLines = defineCollection<BankStatementLineDoc>({
  name: 'bank_statement_lines',
  scope: 'tenant',
  decimals: ['amount'],
  schema: {
    bsonType: 'object',
    required: ['accountId', 'importId', 'date', 'description', 'amount', 'fingerprint', 'status', 'createdAt'],
    properties: { date: { bsonType: 'date' }, amount: { bsonType: 'decimal' }, status: { enum: ['UNMATCHED', 'MATCHED', 'EXCLUDED'] } },
  },
  indexes: [
    { key: { orgId: 1, accountId: 1, fingerprint: 1 }, name: 'org_account_fingerprint', unique: true },
    { key: { orgId: 1, accountId: 1, date: 1 }, name: 'org_account_date' },
    { key: { orgId: 1, accountId: 1, status: 1 }, name: 'org_account_status' },
    { key: { reconciliationId: 1 }, name: 'reconciliation' },
  ],
  // Was t2t_guard_statement_line: what the bank said never changes; reconciled lines are frozen.
  guards: {
    beforeInsert(l) {
      if (l.status !== 'UNMATCHED' || l.reconciliationId !== null) throw new GuardViolation('A statement line starts unmatched');
      checkLine(l);
    },
    async afterUpdate(before, after, ctx) {
      const fixed = (['accountId', 'importId', 'description', 'reference', 'fingerprint', 'orgId'] as const).some((k) => after[k] !== before[k]);
      if (fixed || +after.date !== +before.date || !n(after.amount).eq(before.amount)) throw new GuardViolation('A bank statement line cannot be changed');
      if (before.reconciliationId !== null && after.reconciliationId === before.reconciliationId && (after.status !== before.status || after.excludedReason !== before.excludedReason)) {
        throw new GuardViolation('The statement line is reconciled; undo the reconciliation first');
      }
      if (after.reconciliationId !== null && before.reconciliationId === null && after.status === 'UNMATCHED') throw new GuardViolation('An unmatched statement line cannot be reconciled');
      checkLine(after);
      if (after.status !== before.status) await checkMatches(after, ctx);
    },
    beforeDelete() {
      throw new GuardViolation('A bank statement line cannot be deleted; exclude it instead');
    },
  },
});

export const BANK_LINES: MovedTable = { def: bankStatementLines, model: 'bankStatementLine' };

export interface BankMatchDoc {
  id: string;
  orgId: string;
  statementLineId: string;
  journalLineId: string;
  origin: 'EXISTING' | 'CREATED_ENTRY' | 'CREATED_PAYMENT';
  createdById: string;
  createdAt: Date;
  removedAt: Date | null;
  removedById: string | null;
}

export const bankMatches = defineCollection<BankMatchDoc>({
  name: 'bank_matches',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['statementLineId', 'journalLineId', 'origin', 'createdById', 'createdAt'],
    properties: { origin: { enum: ['EXISTING', 'CREATED_ENTRY', 'CREATED_PAYMENT'] } },
  },
  indexes: [
    { key: { orgId: 1, statementLineId: 1 }, name: 'org_statement_line' },
    { key: { orgId: 1, journalLineId: 1 }, name: 'org_journal_line' },
    // Was bank_matches_active_journal_line_uniq.
    { key: { journalLineId: 1 }, name: 'active_journal_line', unique: true, partialFilterExpression: { removedAt: { $type: 'null' } } },
  ],
  // Was t2t_guard_bank_match: history, removed once, and not while the line is reconciled.
  guards: {
    async beforeInsert(m, ctx) {
      const line = await ctx.collection(bankStatementLines).findOne({ id: m.statementLineId, orgId: m.orgId });
      if (!line) throw new GuardViolation('The statement line does not exist in this organisation');
      if (line.reconciliationId !== null) throw new GuardViolation('The statement line is reconciled; undo the reconciliation first');
      if (m.removedAt !== null) throw new GuardViolation('A match starts active');
    },
    async afterUpdate(before, after, ctx) {
      const fixed = (['statementLineId', 'journalLineId', 'origin', 'createdById', 'orgId'] as const).some((k) => after[k] !== before[k]) || +after.createdAt !== +before.createdAt;
      const again = before.removedAt !== null && (+(after.removedAt ?? 0) !== +before.removedAt || after.removedById !== before.removedById);
      if (fixed || again) throw new GuardViolation('A bank match cannot be changed');
      const line = await ctx.collection(bankStatementLines).findOne({ id: before.statementLineId, orgId: before.orgId });
      if (line?.reconciliationId) throw new GuardViolation('The match belongs to a reconciled line; undo the reconciliation first');
    },
    beforeDelete() {
      throw new GuardViolation('A bank match cannot be deleted; unmatch it instead');
    },
  },
});

export const BANK_MATCHES: MovedTable = { def: bankMatches, model: 'bankMatch' };

export interface BankReconciliationDoc {
  id: string;
  orgId: string;
  accountId: string;
  startDate: Date;
  statementDate: Date;
  openingBalance: string;
  statementBalance: string;
  ledgerBalance: string;
  uncleared: string;
  status: 'COMPLETED' | 'UNDONE';
  completedById: string;
  completedAt: Date;
  undoneById: string | null;
  undoneAt: Date | null;
  undoReason: string | null;
}

const RECONCILED_FIXED = ['accountId', 'openingBalance', 'statementBalance', 'ledgerBalance', 'uncleared', 'orgId'] as const;

export const bankReconciliations = defineCollection<BankReconciliationDoc>({
  name: 'bank_reconciliations',
  scope: 'tenant',
  decimals: ['openingBalance', 'statementBalance', 'ledgerBalance', 'uncleared'],
  schema: {
    bsonType: 'object',
    required: ['accountId', 'startDate', 'statementDate', 'openingBalance', 'statementBalance', 'ledgerBalance', 'uncleared', 'status', 'completedById', 'completedAt'],
    properties: { startDate: { bsonType: 'date' }, statementDate: { bsonType: 'date' }, status: { enum: ['COMPLETED', 'UNDONE'] } },
  },
  indexes: [
    { key: { orgId: 1, accountId: 1, statementDate: 1 }, name: 'org_account_date' },
    // Was bank_reconciliations_completed_uniq.
    { key: { orgId: 1, accountId: 1, statementDate: 1, status: 1 }, name: 'completed_once', unique: true, partialFilterExpression: { status: 'COMPLETED' } },
  ],
  // Was bank_reconciliations_*_chk and t2t_guard_reconciliation.
  guards: {
    beforeInsert(r) {
      if (r.startDate > r.statementDate) throw new GuardViolation('A reconciliation starts on or before its statement date');
      if (r.status !== 'COMPLETED' || r.undoneAt !== null) throw new GuardViolation('A reconciliation is recorded completed');
    },
    afterUpdate(before, after) {
      const changed = RECONCILED_FIXED.some((k) => after[k] !== before[k]) || +after.startDate !== +before.startDate || +after.statementDate !== +before.statementDate;
      if (before.status === 'UNDONE' || changed) throw new GuardViolation('A reconciliation cannot be changed');
      if ((after.status === 'UNDONE') !== (after.undoneAt !== null)) throw new GuardViolation('An undone reconciliation says when');
    },
    beforeDelete() {
      throw new GuardViolation('A reconciliation cannot be deleted; undo it instead');
    },
  },
});

export const BANK_RECONCILIATIONS: MovedTable = { def: bankReconciliations, model: 'bankReconciliation' };
