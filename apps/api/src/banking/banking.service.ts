import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  D,
  Dec,
  Ledger,
  StatementMapping,
  dec,
  minorUnits,
  parseStatement,
  reconciliationDifference,
  reconciliationIssues,
  statementLineKeys,
  suggestMatches,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { DocumentsService } from '../ledgers/documents.service';

export interface BankOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
interface Actor {
  id: string;
}

const BANK_SUBTYPES = ['BANK', 'CASH'];
const entryNo = (n: number | null) => (n ? `JE-${String(n).padStart(6, '0')}` : null);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface LedgerLineRow {
  id: string;
  entry_id: string;
  entry_number: number | null;
  date: Date;
  memo: string | null;
  reference: string | null;
  description: string | null;
  source: string;
  reverses_entry_id: string | null;
  net: Prisma.Decimal;
}

/**
 * Bank statement import, matching and reconciliation (Directive Part 8).
 *
 * A bank account is a postable ledger account with subtype BANK or CASH. Statement
 * lines are what the bank says happened; they are matched to posted ledger lines on
 * that account. Creating an entry or a receipt from a statement line posts through
 * the same journal engine as everything else. A completed reconciliation freezes the
 * lines it covers until it is undone.
 */
@Injectable()
export class BankingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly documents: DocumentsService,
  ) {}

  // ------------------------------------------------------------- accounts

  async listAccounts(org: BankOrg) {
    const accounts = await this.prisma.account.findMany({
      where: { orgId: org.id, subtype: { in: BANK_SUBTYPES }, isPostable: true },
      orderBy: { code: 'asc' },
    });
    const ids = accounts.map((a) => a.id);
    if (!ids.length) return [];
    const [ledger, lines, recs] = await Promise.all([
      this.prisma.$queryRaw<{ account_id: string; net: Prisma.Decimal }[]>`
        SELECT jl.account_id, SUM(jl.functional_debit - jl.functional_credit) AS net
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.org_id = ${org.id}::uuid AND je.status = 'POSTED' AND jl.account_id = ANY(${ids}::uuid[])
        GROUP BY jl.account_id`,
      this.prisma.$queryRaw<{ account_id: string; unmatched: bigint; total: bigint; last_date: Date | null }[]>`
        SELECT account_id, COUNT(*) FILTER (WHERE status = 'UNMATCHED') AS unmatched, COUNT(*) AS total, MAX(date) AS last_date
        FROM bank_statement_lines WHERE org_id = ${org.id}::uuid GROUP BY account_id`,
      this.prisma.bankReconciliation.findMany({ where: { orgId: org.id, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } }),
    ]);
    const scale = minorUnits(org.functionalCurrency);
    return accounts.map((a) => {
      const l = lines.find((x) => x.account_id === a.id);
      const r = recs.find((x) => x.accountId === a.id);
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        subtype: a.subtype,
        isActive: a.isActive,
        ledgerBalance: new D((ledger.find((x) => x.account_id === a.id)?.net ?? 0).toString()).toFixed(scale),
        statementLines: Number(l?.total ?? 0),
        unmatchedLines: Number(l?.unmatched ?? 0),
        lastStatementDate: l?.last_date ? fromDbDate(l.last_date) : null,
        lastReconciled: r ? { date: fromDbDate(r.statementDate), statementBalance: r.statementBalance.toFixed(scale) } : null,
      };
    });
  }

  // --------------------------------------------------------------- import

  async importStatement(org: BankOrg, actor: Actor, accountId: string, input: { fileName: string; csv: string; mapping: StatementMapping; dryRun: boolean }) {
    const account = await this.bankAccount(this.prisma, org.id, accountId);
    const parsed = parseStatement(input.csv, input.mapping, org.functionalCurrency);
    const fingerprints = statementLineKeys(accountId, parsed).map(sha);
    const run = async (db: Tx | PrismaService) => {
      const existing = new Set(
        (await db.bankStatementLine.findMany({ where: { orgId: org.id, accountId, fingerprint: { in: fingerprints } }, select: { fingerprint: true } })).map((x) => x.fingerprint),
      );
      const last = await db.bankReconciliation.findFirst({ where: { orgId: org.id, accountId, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } });
      const lockedUntil = last ? fromDbDate(last.statementDate) : null;
      const rows = parsed.map((l, i) => ({ ...l, fingerprint: fingerprints[i], duplicate: existing.has(fingerprints[i]) }));
      const fresh = rows.filter((r) => !r.duplicate);
      const blocked = lockedUntil ? fresh.filter((r) => r.date <= lockedUntil) : [];
      return { rows, fresh, blocked, lockedUntil };
    };
    const scale = minorUnits(org.functionalCurrency);
    const preview = (r: Awaited<ReturnType<typeof run>>) => ({
      accountId,
      lines: r.rows.map((x) => ({ row: x.row, date: x.date, description: x.description, reference: x.reference, amount: x.amount.toFixed(scale), duplicate: x.duplicate })),
      newCount: r.fresh.length,
      duplicateCount: r.rows.length - r.fresh.length,
      moneyIn: r.fresh.filter((x) => x.amount.gt(0)).reduce((s, x) => s.plus(x.amount), new D(0)).toFixed(scale),
      moneyOut: r.fresh.filter((x) => x.amount.lt(0)).reduce((s, x) => s.plus(x.amount), new D(0)).negated().toFixed(scale),
      reconciledUntil: r.lockedUntil,
      blockedRows: r.blocked.map((x) => x.row),
    });
    if (input.dryRun) return { imported: false, ...preview(await run(this.prisma)) };

    return this.prisma.$transaction(async (tx) => {
      await this.lockAccount(tx, org.id, accountId);
      const r = await run(tx);
      if (r.blocked.length) {
        throw new DomainError(
          'PERIOD_RECONCILED',
          `${account.code} is reconciled up to ${r.lockedUntil}; rows ${r.blocked.map((x) => x.row).slice(0, 10).join(', ')} are on or before that date. Undo the reconciliation or remove those rows.`,
          HttpStatus.CONFLICT,
        );
      }
      if (!r.fresh.length) throw new DomainError('NOTHING_NEW', 'Every line in this file has already been imported', HttpStatus.CONFLICT);
      const dates = r.fresh.map((x) => x.date).sort();
      const imp = await tx.bankStatementImport.create({
        data: {
          orgId: org.id,
          accountId,
          fileName: input.fileName.slice(0, 200),
          fileHash: sha(input.csv),
          lineCount: r.fresh.length,
          skippedCount: r.rows.length - r.fresh.length,
          firstDate: toDbDate(dates[0]),
          lastDate: toDbDate(dates[dates.length - 1]),
          importedById: actor.id,
        },
      });
      await tx.bankStatementLine.createMany({
        data: r.fresh.map((x) => ({
          orgId: org.id,
          accountId,
          importId: imp.id,
          date: toDbDate(x.date),
          description: x.description,
          reference: x.reference,
          amount: x.amount.toFixed(),
          fingerprint: x.fingerprint,
        })),
      });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'bank.statement_imported',
        entityType: 'bank_statement_import',
        entityId: imp.id,
        data: { accountId, fileName: imp.fileName, fileHash: imp.fileHash, lines: imp.lineCount, skipped: imp.skippedCount },
      });
      return { imported: true, importId: imp.id, ...preview(r) };
    });
  }

  async listImports(org: BankOrg, accountId: string) {
    await this.bankAccount(this.prisma, org.id, accountId);
    const rows = await this.prisma.bankStatementImport.findMany({ where: { orgId: org.id, accountId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((i) => ({
      id: i.id,
      fileName: i.fileName,
      lineCount: i.lineCount,
      skippedCount: i.skippedCount,
      firstDate: fromDbDate(i.firstDate),
      lastDate: fromDbDate(i.lastDate),
      createdAt: i.createdAt.toISOString(),
    }));
  }

  // ---------------------------------------------------------------- lines

  async listLines(org: BankOrg, accountId: string, q: { status?: 'UNMATCHED' | 'MATCHED' | 'EXCLUDED'; from?: string; to?: string; limit: number; offset: number }) {
    await this.bankAccount(this.prisma, org.id, accountId);
    const where: Prisma.BankStatementLineWhereInput = {
      orgId: org.id,
      accountId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: toDbDate(q.from) } : {}), ...(q.to ? { lte: toDbDate(q.to) } : {}) } } : {}),
    };
    const [total, lines] = await Promise.all([
      this.prisma.bankStatementLine.count({ where }),
      this.prisma.bankStatementLine.findMany({ where, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: q.limit, skip: q.offset }),
    ]);
    const unmatched = lines.filter((l) => l.status === 'UNMATCHED');
    const suggestions = unmatched.length ? await this.suggestionsFor(this.prisma, org, accountId, unmatched) : [];
    return { total, lines: await this.serializeLines(this.prisma, org, lines, suggestions) };
  }

  async getLine(org: BankOrg, lineId: string) {
    const line = await this.findLine(this.prisma, org.id, lineId);
    const suggestions = line.status === 'UNMATCHED' ? await this.suggestionsFor(this.prisma, org, line.accountId, [line]) : [];
    return (await this.serializeLines(this.prisma, org, [line], suggestions))[0];
  }

  /** Unmatched posted ledger lines on the account, nearest in amount and date first. */
  async candidates(org: BankOrg, lineId: string, q: { search?: string }) {
    const line = await this.findLine(this.prisma, org.id, lineId);
    const rows = await this.unmatchedLedgerLines(this.prisma, org.id, line.accountId, {
      from: addDay(fromDbDate(line.date), -90),
      to: addDay(fromDbDate(line.date), 90),
      search: q.search,
    });
    const target = new D(line.amount.toString());
    const day = Date.parse(fromDbDate(line.date));
    rows.sort((a, b) => {
      const da = new D(a.net.toString()).minus(target).abs().cmp(new D(b.net.toString()).minus(target).abs());
      if (da) return da;
      return Math.abs(Date.parse(fromDbDate(a.date)) - day) - Math.abs(Date.parse(fromDbDate(b.date)) - day);
    });
    return rows.slice(0, 100).map((r) => this.serializeLedgerLine(org, r));
  }

  async match(org: BankOrg, actor: Actor, lineId: string, journalLineIds: string[]) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      await this.matchInTx(tx, org, actor, line, journalLineIds, 'EXISTING');
      return this.reload(tx, org, lineId);
    });
  }

  /** Applies only suggestions where the pair is each other's only same-amount candidate. */
  async autoMatch(org: BankOrg, actor: Actor, accountId: string) {
    return this.inTx(async (tx) => {
      await this.lockAccount(tx, org.id, accountId);
      const lines = await tx.bankStatementLine.findMany({ where: { orgId: org.id, accountId, status: 'UNMATCHED' } });
      const suggestions = (await this.suggestionsFor(tx, org, accountId, lines)).filter((s) => s.unique);
      for (const s of suggestions) {
        const line = await this.lockLine(tx, org.id, s.statementLineId);
        await this.matchInTx(tx, org, actor, line, [s.journalLineId], 'EXISTING');
      }
      return { matched: suggestions.length };
    });
  }

  async unmatch(org: BankOrg, actor: Actor, lineId: string, input: { date?: string }) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      if (line.status !== 'MATCHED') throw new DomainError('NOT_MATCHED', 'This statement line is not matched', HttpStatus.CONFLICT);
      if (line.reconciliationId) throw new DomainError('LINE_RECONCILED', 'This line is reconciled; undo the reconciliation first', HttpStatus.CONFLICT);
      const matches = await tx.bankMatch.findMany({ where: { statementLineId: lineId, removedAt: null }, include: { journalLine: true } });
      const now = new Date();
      await tx.bankMatch.updateMany({ where: { statementLineId: lineId, removedAt: null }, data: { removedAt: now, removedById: actor.id } });
      await tx.bankStatementLine.update({ where: { id: lineId }, data: { status: 'UNMATCHED' } });
      const reversed: string[] = [];
      // An entry that was created from this line only exists because of it: reverse it too.
      const created = [...new Set(matches.filter((m) => m.origin === 'CREATED_ENTRY').map((m) => m.journalLine.entryId))];
      for (const entryId of created) {
        const e = await tx.journalEntry.findUniqueOrThrow({ where: { id: entryId } });
        const r = await this.journals.reverseSystemEntry(tx, org, actor, entryId, {
          date: input.date ?? fromDbDate(e.date),
          memo: `Reverses ${entryNo(e.entryNumber)} · bank line unmatched`,
        });
        reversed.push(r.id);
      }
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'bank.line_unmatched',
        entityType: 'bank_statement_line',
        entityId: lineId,
        data: { journalLineIds: matches.map((m) => m.journalLineId), reversedEntryIds: reversed },
      });
      return { line: await this.reload(tx, org, lineId), reversedEntryIds: reversed };
    });
  }

  /** Posts a bank entry (money in: Dr bank / Cr account; money out: Dr account / Cr bank) and matches it. */
  async createEntry(org: BankOrg, actor: Actor, lineId: string, input: { accountId: string; description?: string }) {
    this.require(org, 'journals.post', 'post entries from bank lines');
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      if (input.accountId === line.accountId) throw new DomainError('INVALID_ACCOUNT', 'Choose the account on the other side of the bank line, not the bank account itself');
      const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true } });
      if (input.accountId === o.arAccountId || input.accountId === o.apAccountId) {
        throw new DomainError('CONTROL_ACCOUNT', 'Money from customers or to vendors goes through "Record a receipt / payment" so it reaches the right invoice or bill');
      }
      const amount = new D(line.amount.toString());
      const abs = amount.abs().toFixed();
      const text = (input.description?.trim() || line.description).slice(0, 500);
      const bankSide = { accountId: line.accountId, description: text, ...(amount.gt(0) ? { debit: abs } : { credit: abs }) };
      const otherSide = { accountId: input.accountId, description: text, ...(amount.gt(0) ? { credit: abs } : { debit: abs }) };
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: fromDbDate(line.date),
        source: 'BANK',
        memo: `Bank: ${text}`,
        reference: line.reference ?? undefined,
        lines: [bankSide, otherSide],
      });
      const bankLine = await tx.journalLine.findFirstOrThrow({ where: { entryId: je.id, accountId: line.accountId } });
      await this.matchInTx(tx, org, actor, line, [bankLine.id], 'CREATED_ENTRY');
      return this.reload(tx, org, lineId);
    });
  }

  /** Records a customer receipt (money in) or vendor payment (money out) for the line and matches it. */
  async recordPayment(org: BankOrg, actor: Actor, lineId: string, input: { contactId: string; allocations: { documentId: string; amount: string }[]; memo?: string }) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      const amount = new D(line.amount.toString());
      const ledger: Ledger = amount.gt(0) ? 'SALES' : 'PURCHASES';
      this.require(org, ledger === 'SALES' ? 'sales.manage' : 'purchases.manage', ledger === 'SALES' ? 'record receipts' : 'record payments');
      const p = await this.documents.recordPaymentInTx(tx, org, actor, ledger, {
        contactId: input.contactId,
        date: fromDbDate(line.date),
        bankAccountId: line.accountId,
        amount: amount.abs().toFixed(),
        reference: line.reference ?? line.description.slice(0, 100),
        memo: input.memo ?? null,
        allocations: input.allocations,
      });
      const bankLine = await tx.journalLine.findFirstOrThrow({ where: { entryId: p.journalEntryId, accountId: line.accountId } });
      await this.matchInTx(tx, org, actor, line, [bankLine.id], 'CREATED_PAYMENT');
      return this.reload(tx, org, lineId);
    });
  }

  async exclude(org: BankOrg, actor: Actor, lineId: string, reason: string) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      await tx.bankStatementLine.update({ where: { id: lineId }, data: { status: 'EXCLUDED', excludedReason: reason } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.line_excluded', entityType: 'bank_statement_line', entityId: lineId, data: { reason } });
      return this.reload(tx, org, lineId);
    });
  }

  async include(org: BankOrg, actor: Actor, lineId: string) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      if (line.status !== 'EXCLUDED') throw new DomainError('NOT_EXCLUDED', 'This statement line is not excluded', HttpStatus.CONFLICT);
      if (line.reconciliationId) throw new DomainError('LINE_RECONCILED', 'This line is reconciled; undo the reconciliation first', HttpStatus.CONFLICT);
      await tx.bankStatementLine.update({ where: { id: lineId }, data: { status: 'UNMATCHED', excludedReason: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.line_included', entityType: 'bank_statement_line', entityId: lineId, data: {} });
      return this.reload(tx, org, lineId);
    });
  }

  // -------------------------------------------------------- reconciliation

  async previewReconciliation(org: BankOrg, accountId: string, input: { statementDate: string; statementBalance: string; openingBalance?: string }) {
    await this.bankAccount(this.prisma, org.id, accountId);
    return this.figures(this.prisma, org, accountId, input);
  }

  async completeReconciliation(org: BankOrg, actor: Actor, accountId: string, input: { statementDate: string; statementBalance: string; openingBalance?: string }) {
    return this.inTx(async (tx) => {
      await this.lockAccount(tx, org.id, accountId);
      const f = await this.figures(tx, org, accountId, input);
      if (f.issues.length) throw new DomainError('RECONCILIATION_FAILED', 'The account does not reconcile yet', HttpStatus.UNPROCESSABLE_ENTITY, { issues: f.issues });
      const rec = await tx.bankReconciliation.create({
        data: {
          orgId: org.id,
          accountId,
          startDate: toDbDate(f.startDate),
          statementDate: toDbDate(f.statementDate),
          openingBalance: f.openingBalance,
          statementBalance: f.statementBalance,
          ledgerBalance: f.ledgerBalance,
          uncleared: f.uncleared,
          completedById: actor.id,
        },
      });
      const updated = await tx.bankStatementLine.updateMany({
        where: { orgId: org.id, accountId, reconciliationId: null, date: { gte: toDbDate(f.startDate), lte: toDbDate(f.statementDate) } },
        data: { reconciliationId: rec.id },
      });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'bank.reconciled',
        entityType: 'bank_reconciliation',
        entityId: rec.id,
        data: { accountId, statementDate: f.statementDate, statementBalance: f.statementBalance, ledgerBalance: f.ledgerBalance, uncleared: f.uncleared, lines: updated.count },
      });
      return this.serializeReconciliation(org, rec, updated.count);
    });
  }

  async listReconciliations(org: BankOrg, accountId: string) {
    await this.bankAccount(this.prisma, org.id, accountId);
    const recs = await this.prisma.bankReconciliation.findMany({
      where: { orgId: org.id, accountId },
      orderBy: [{ statementDate: 'desc' }, { completedAt: 'desc' }],
      include: { _count: { select: { lines: true } } },
    });
    return recs.map((r) => this.serializeReconciliation(org, r, r._count.lines));
  }

  /** Only the latest completed reconciliation of an account can be undone. */
  async undoReconciliation(org: BankOrg, actor: Actor, id: string, reason: string) {
    this.require(org, 'periods.lock', 'undo a reconciliation');
    return this.inTx(async (tx) => {
      const found = await tx.bankReconciliation.findFirst({ where: { id, orgId: org.id } });
      if (!found) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Reconciliation not found' });
      await this.lockAccount(tx, org.id, found.accountId);
      const rec = await tx.bankReconciliation.findUniqueOrThrow({ where: { id } });
      if (rec.status !== 'COMPLETED') throw new DomainError('ALREADY_UNDONE', 'This reconciliation has already been undone', HttpStatus.CONFLICT);
      const later = await tx.bankReconciliation.findFirst({ where: { orgId: org.id, accountId: rec.accountId, status: 'COMPLETED', statementDate: { gt: rec.statementDate } } });
      if (later) throw new DomainError('NOT_LATEST', `Undo the reconciliation to ${fromDbDate(later.statementDate)} first`, HttpStatus.CONFLICT);
      const released = await tx.bankStatementLine.updateMany({ where: { reconciliationId: id }, data: { reconciliationId: null } });
      const done = await tx.bankReconciliation.update({ where: { id }, data: { status: 'UNDONE', undoneAt: new Date(), undoneById: actor.id, undoReason: reason } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.reconciliation_undone', entityType: 'bank_reconciliation', entityId: id, data: { reason, lines: released.count } });
      return this.serializeReconciliation(org, done, 0);
    });
  }

  // ------------------------------------------------------------- internals

  private async figures(db: Tx | PrismaService, org: BankOrg, accountId: string, input: { statementDate: string; statementBalance: string; openingBalance?: string }) {
    const scale = minorUnits(org.functionalCurrency);
    const statementDate = input.statementDate;
    const statementBalance = this.amount(org, input.statementBalance, 'Statement balance');
    const completed = await db.bankReconciliation.findMany({ where: { orgId: org.id, accountId, status: 'COMPLETED' }, orderBy: { statementDate: 'asc' } });
    const prev = completed[completed.length - 1];
    let startDate: string;
    let openingBalance: Dec;
    if (prev) {
      if (statementDate <= fromDbDate(prev.statementDate)) {
        throw new DomainError('INVALID_DATE', `The statement date must be after the last reconciliation (${fromDbDate(prev.statementDate)})`);
      }
      startDate = addDay(fromDbDate(prev.statementDate), 1);
      openingBalance = new D(prev.statementBalance.toString());
      if (input.openingBalance !== undefined && !this.amount(org, input.openingBalance, 'Opening balance').eq(openingBalance)) {
        throw new DomainError('OPENING_MISMATCH', `The opening balance is the last reconciled balance, ${openingBalance.toFixed(scale)}`);
      }
    } else {
      if (input.openingBalance === undefined) throw new DomainError('OPENING_REQUIRED', 'Enter the opening balance shown on the first statement');
      openingBalance = this.amount(org, input.openingBalance, 'Opening balance');
      const first = await db.bankStatementLine.findFirst({ where: { orgId: org.id, accountId, reconciliationId: null }, orderBy: { date: 'asc' } });
      startDate = first && fromDbDate(first.date) <= statementDate ? fromDbDate(first.date) : statementDate;
    }
    // Ledger lines before reconciliations began are treated as already cleared, unless a statement line matches them later.
    const clearedBefore = completed.length ? fromDbDate(completed[0].startDate) : startDate;

    const inRange = await db.bankStatementLine.findMany({
      where: { orgId: org.id, accountId, reconciliationId: null, date: { gte: toDbDate(startDate), lte: toDbDate(statementDate) } },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    const movement = inRange.filter((l) => l.status !== 'EXCLUDED').reduce((s, l) => s.plus(l.amount.toString()), new D(0));
    const unmatched = inRange.filter((l) => l.status === 'UNMATCHED');

    const [{ net }] = await db.$queryRaw<{ net: Prisma.Decimal | null }[]>`
      SELECT SUM(jl.functional_debit - jl.functional_credit) AS net
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.org_id = ${org.id}::uuid AND jl.account_id = ${accountId}::uuid AND je.status = 'POSTED' AND je.date <= ${toDbDate(statementDate)}::date`;
    const ledgerBalance = new D((net ?? 0).toString());

    const uncleared = await db.$queryRaw<LedgerLineRow[]>`
      SELECT jl.id, jl.entry_id, je.entry_number, je.date, je.memo, je.reference, jl.description, je.source::text AS source, je.reverses_entry_id,
             (jl.functional_debit - jl.functional_credit) AS net
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.org_id = ${org.id}::uuid AND jl.account_id = ${accountId}::uuid AND je.status = 'POSTED'
        AND je.date <= ${toDbDate(statementDate)}::date
        AND NOT EXISTS (
          SELECT 1 FROM bank_matches m JOIN bank_statement_lines s ON s.id = m.statement_line_id
          WHERE m.journal_line_id = jl.id AND m.removed_at IS NULL AND s.date <= ${toDbDate(statementDate)}::date)
        AND (je.date >= ${toDbDate(clearedBefore)}::date OR EXISTS (
          SELECT 1 FROM bank_matches m JOIN bank_statement_lines s ON s.id = m.statement_line_id
          WHERE m.journal_line_id = jl.id AND m.removed_at IS NULL))
      ORDER BY je.date, je.entry_number`;
    const outstanding = dropReversalPairs(uncleared);
    const unclearedTotal = outstanding.reduce((s, r) => s.plus(r.net.toString()), new D(0));

    const f = { computedStatementBalance: openingBalance.plus(movement), statementBalance, ledgerBalance, uncleared: unclearedTotal };
    const issues = reconciliationIssues(f, unmatched.length);
    if (statementDate > todayIso()) issues.unshift('The statement date cannot be in the future');
    return {
      startDate,
      statementDate,
      openingBalance: openingBalance.toFixed(scale),
      statementBalance: statementBalance.toFixed(scale),
      computedStatementBalance: f.computedStatementBalance.toFixed(scale),
      ledgerBalance: ledgerBalance.toFixed(scale),
      uncleared: unclearedTotal.toFixed(scale),
      difference: reconciliationDifference(f).toFixed(scale),
      linesInRange: inRange.length,
      unmatchedLines: unmatched.map((l) => ({ id: l.id, date: fromDbDate(l.date), description: l.description, amount: new D(l.amount.toString()).toFixed(scale) })),
      unclearedLines: outstanding.map((r) => this.serializeLedgerLine(org, r)),
      firstReconciliation: !prev,
      issues,
      canComplete: issues.length === 0,
    };
  }

  private async matchInTx(tx: Tx, org: BankOrg, actor: Actor, line: Awaited<ReturnType<BankingService['lockLine']>>, journalLineIds: string[], origin: 'EXISTING' | 'CREATED_ENTRY' | 'CREATED_PAYMENT') {
    this.assertOpen(line);
    const ids = [...new Set(journalLineIds)];
    if (!ids.length) throw new DomainError('INVALID_MATCH', 'Choose at least one ledger line');
    const rows = await tx.$queryRaw<{ id: string; account_id: string; status: string; net: Prisma.Decimal; matched: boolean }[]>`
      SELECT jl.id, jl.account_id, je.status::text AS status, (jl.functional_debit - jl.functional_credit) AS net,
             EXISTS (SELECT 1 FROM bank_matches m WHERE m.journal_line_id = jl.id AND m.removed_at IS NULL) AS matched
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.org_id = ${org.id}::uuid AND jl.id = ANY(${ids}::uuid[])
      FOR UPDATE OF jl`;
    const issues: string[] = [];
    if (rows.length !== ids.length) issues.push('Some ledger lines were not found');
    for (const r of rows) {
      if (r.account_id !== line.accountId) issues.push('Every ledger line must be on this bank account');
      else if (r.status !== 'POSTED') issues.push('Only posted ledger lines can be matched');
      else if (r.matched) issues.push('A chosen ledger line is already matched to another statement line');
    }
    const total = rows.reduce((s, r) => s.plus(r.net.toString()), new D(0));
    const amount = new D(line.amount.toString());
    if (!issues.length && !total.eq(amount)) {
      issues.push(`The chosen ledger lines add up to ${total.toFixed(2)}, not ${amount.toFixed(2)}`);
    }
    if (issues.length) throw new DomainError('INVALID_MATCH', [...new Set(issues)].join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues: [...new Set(issues)] });
    await tx.bankMatch.createMany({ data: ids.map((journalLineId) => ({ orgId: org.id, statementLineId: line.id, journalLineId, origin, createdById: actor.id })) });
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { status: 'MATCHED' } });
    await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.line_matched', entityType: 'bank_statement_line', entityId: line.id, data: { journalLineIds: ids, origin } });
  }

  private async suggestionsFor(db: Tx | PrismaService, org: BankOrg, accountId: string, lines: { id: string; date: Date; amount: Prisma.Decimal; description: string; reference: string | null }[]) {
    const dates = lines.map((l) => fromDbDate(l.date)).sort();
    const ledger = await this.unmatchedLedgerLines(db, org.id, accountId, { from: addDay(dates[0], -14), to: addDay(dates[dates.length - 1], 14) });
    return suggestMatches(
      lines.map((l) => ({ id: l.id, date: fromDbDate(l.date), amount: new D(l.amount.toString()), text: `${l.description} ${l.reference ?? ''}` })),
      ledger.map((r) => ({ id: r.id, date: fromDbDate(r.date), amount: new D(r.net.toString()), text: `${r.memo ?? ''} ${r.reference ?? ''} ${r.description ?? ''}` })),
    );
  }

  private unmatchedLedgerLines(db: Tx | PrismaService, orgId: string, accountId: string, q: { from: string; to: string; search?: string }) {
    const search = q.search?.trim() ? Prisma.sql`AND (je.memo ILIKE ${'%' + q.search.trim() + '%'} OR je.reference ILIKE ${'%' + q.search.trim() + '%'} OR jl.description ILIKE ${'%' + q.search.trim() + '%'})` : Prisma.empty;
    return db.$queryRaw<LedgerLineRow[]>`
      SELECT jl.id, jl.entry_id, je.entry_number, je.date, je.memo, je.reference, jl.description, je.source::text AS source, je.reverses_entry_id,
             (jl.functional_debit - jl.functional_credit) AS net
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
      WHERE jl.org_id = ${orgId}::uuid AND jl.account_id = ${accountId}::uuid AND je.status = 'POSTED'
        AND je.date BETWEEN ${toDbDate(q.from)}::date AND ${toDbDate(q.to)}::date
        AND NOT EXISTS (SELECT 1 FROM bank_matches m WHERE m.journal_line_id = jl.id AND m.removed_at IS NULL)
        ${search}
      ORDER BY je.date, je.entry_number
      LIMIT 1000`;
  }

  private async serializeLines(
    db: Tx | PrismaService,
    org: BankOrg,
    lines: { id: string; accountId: string; date: Date; description: string; reference: string | null; amount: Prisma.Decimal; status: string; excludedReason: string | null; reconciliationId: string | null; importId: string }[],
    suggestions: ReturnType<typeof suggestMatches>,
  ) {
    const scale = minorUnits(org.functionalCurrency);
    const ids = lines.map((l) => l.id);
    const matches = ids.length
      ? await db.bankMatch.findMany({
          where: { statementLineId: { in: ids }, removedAt: null },
          include: { journalLine: { include: { entry: true } } },
        })
      : [];
    const entryIds = [...new Set([...matches.map((m) => m.journalLine.entryId)])];
    const suggested = suggestions.length
      ? await db.journalLine.findMany({ where: { id: { in: suggestions.map((s) => s.journalLineId) } }, include: { entry: true } })
      : [];
    const payments = await db.payment.findMany({
      where: { orgId: org.id, journalEntryId: { in: [...entryIds, ...suggested.map((s) => s.entryId)] } },
      include: { contact: { select: { name: true } } },
    });
    const link = (l: { id: string; entryId: string; functionalDebit: Prisma.Decimal; functionalCredit: Prisma.Decimal; description: string | null; entry: { entryNumber: number | null; date: Date; memo: string | null; reference: string | null; source: string } }) => {
      const p = payments.find((x) => x.journalEntryId === l.entryId);
      return {
        journalLineId: l.id,
        entryId: l.entryId,
        entryNumber: entryNo(l.entry.entryNumber),
        date: fromDbDate(l.entry.date),
        memo: l.entry.memo,
        reference: l.entry.reference,
        source: l.entry.source,
        amount: new D(l.functionalDebit.toString()).minus(l.functionalCredit.toString()).toFixed(scale),
        payment: p ? { id: p.id, number: p.number, kind: p.kind, contactName: p.contact.name } : null,
      };
    };
    return lines.map((l) => {
      const s = suggestions.find((x) => x.statementLineId === l.id);
      const sl = s ? suggested.find((x) => x.id === s.journalLineId) : undefined;
      return {
        id: l.id,
        accountId: l.accountId,
        importId: l.importId,
        date: fromDbDate(l.date),
        description: l.description,
        reference: l.reference,
        amount: new D(l.amount.toString()).toFixed(scale),
        status: l.status,
        excludedReason: l.excludedReason,
        reconciled: !!l.reconciliationId,
        matches: matches.filter((m) => m.statementLineId === l.id).map((m) => ({ id: m.id, origin: m.origin, ...link(m.journalLine) })),
        suggestion: s && sl ? { ...link(sl), score: s.score, reasons: s.reasons, unique: s.unique } : null,
      };
    });
  }

  private serializeLedgerLine(org: BankOrg, r: LedgerLineRow) {
    return {
      journalLineId: r.id,
      entryId: r.entry_id,
      entryNumber: entryNo(r.entry_number),
      date: fromDbDate(r.date),
      memo: r.memo,
      reference: r.reference,
      description: r.description,
      source: r.source,
      amount: new D(r.net.toString()).toFixed(minorUnits(org.functionalCurrency)),
    };
  }

  private serializeReconciliation(
    org: BankOrg,
    r: { id: string; accountId: string; startDate: Date; statementDate: Date; openingBalance: Prisma.Decimal; statementBalance: Prisma.Decimal; ledgerBalance: Prisma.Decimal; uncleared: Prisma.Decimal; status: string; completedAt: Date; undoneAt: Date | null; undoReason: string | null },
    lines: number,
  ) {
    const scale = minorUnits(org.functionalCurrency);
    return {
      id: r.id,
      accountId: r.accountId,
      startDate: fromDbDate(r.startDate),
      statementDate: fromDbDate(r.statementDate),
      openingBalance: r.openingBalance.toFixed(scale),
      statementBalance: r.statementBalance.toFixed(scale),
      ledgerBalance: r.ledgerBalance.toFixed(scale),
      uncleared: r.uncleared.toFixed(scale),
      status: r.status,
      completedAt: r.completedAt.toISOString(),
      undoneAt: r.undoneAt?.toISOString() ?? null,
      undoReason: r.undoReason,
      lines,
    };
  }

  private async reload(tx: Tx, org: BankOrg, lineId: string) {
    const line = await tx.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } });
    return (await this.serializeLines(tx, org, [line], []))[0];
  }

  private amount(org: BankOrg, v: string, label: string): Dec {
    const n = dec(v);
    if (n.decimalPlaces() > minorUnits(org.functionalCurrency)) throw new DomainError('INVALID_AMOUNT', `${label} has too many decimal places`);
    return n;
  }

  private assertOpen(line: { status: string; reconciliationId: string | null }) {
    if (line.reconciliationId) throw new DomainError('LINE_RECONCILED', 'This line is reconciled; undo the reconciliation first', HttpStatus.CONFLICT);
    if (line.status === 'MATCHED') throw new DomainError('ALREADY_MATCHED', 'This statement line is already matched; unmatch it first', HttpStatus.CONFLICT);
    if (line.status === 'EXCLUDED') throw new DomainError('LINE_EXCLUDED', 'This statement line is excluded; include it again first', HttpStatus.CONFLICT);
  }

  private require(org: BankOrg, permission: Permission, what: string) {
    if (!hasPermission(org.role, permission)) {
      throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
    }
  }

  private async bankAccount(db: Tx | PrismaService, orgId: string, accountId: string) {
    const a = await db.account.findFirst({ where: { id: accountId, orgId } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank account not found' });
    if (!a.isPostable || !BANK_SUBTYPES.includes(a.subtype ?? '')) throw new DomainError('INVALID_BANK_ACCOUNT', `${a.code} ${a.name} is not a bank or cash account`);
    return a;
  }

  /** Serialises imports, auto-matching and reconciliation per bank account. */
  private async lockAccount(tx: Tx, orgId: string, accountId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM accounts WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank account not found' });
    return this.bankAccount(tx, orgId, accountId);
  }

  private async findLine(db: Tx | PrismaService, orgId: string, id: string) {
    const l = await db.bankStatementLine.findFirst({ where: { id, orgId } });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
    return l;
  }

  private async lockLine(tx: Tx, orgId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bank_statement_lines WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id } });
  }

  /** A concurrent match of the same ledger line hits the partial unique index; report it plainly. */
  private async inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn, { timeout: 20_000 });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError('ALREADY_MATCHED', 'That ledger line was matched by someone else at the same moment; refresh and try again', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }
}

/** An entry and its reversal that are both still uncleared net to zero; leave both out of the list. */
function dropReversalPairs(rows: LedgerLineRow[]): LedgerLineRow[] {
  const entries = new Set(rows.map((r) => r.entry_id));
  const paired = new Set<string>();
  for (const r of rows) {
    if (r.reverses_entry_id && entries.has(r.reverses_entry_id)) {
      paired.add(r.entry_id);
      paired.add(r.reverses_entry_id);
    }
  }
  return rows.filter((r) => !paired.has(r.entry_id));
}
