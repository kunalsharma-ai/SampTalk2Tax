import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  D,
  Dec,
  Ledger,
  StatementMapping,
  dec,
  minorUnits,
  balanceBreaks,
  DateFormat,
  detectStatementFormat,
  fileTotalsCheck,
  ParsedStatementLine,
  parseStatement,
  parseStatementFile,
  StatementFile,
  StatementFormat,
  StatementImportError,
  reconciliationDifference,
  reconciliationIssues,
  statementLineKeys,
  suggestMatches,
  learnedPatterns,
  type LearnedMatch,
  suggestTransfers,
  isSupportedCurrency,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { BANK_IMPORTS, BANK_LINES, BANK_MATCHES, BANK_RECONCILIATIONS, bankStatementImports } from '../db/collections/banking';
import { runInOrg } from '../common/tenant-context';
import { MovedTables } from '../db/moved-table';
import { DocumentStoreService } from '../common/document-store.service';
import { ledgerLines, lineSums, postedBetween, type LedgerLine } from '../db/ledger-queries';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { DocumentsService } from '../ledgers/documents.service';
import { holdLock, lockRow } from '../db/locks';

export interface BankOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
interface Actor {
  id: string;
}

const BANK_SUBTYPES = ['BANK', 'CASH'];
/** How many recent matches in the organisation suggestions learn from. */
const LEARN_FROM_MATCHES = 2000;
const entryNo = (n: number | null) => (n ? `JE-${String(n).padStart(6, '0')}` : null);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** A ledger line as the bank sees it: in the account's own currency when it keeps another one (BANK-012). */
const toRow = (l: LedgerLine, foreign = false): LedgerLineRow => ({ id: l.id, entry_id: l.entry_id, entry_number: l.entry_number, date: l.date, memo: l.memo, reference: l.reference, description: l.description, source: l.source, reverses_entry_id: l.reverses_entry_id, net: new Prisma.Decimal((foreign ? l.tx_net : l.net).toFixed()) });

/** The currency a bank account's statements are in, and whether it differs from the books'. */
interface Book {
  currency: string;
  foreign: boolean;
  scale: number;
  /** Ledger lines that belong on its statements: in a foreign account, only those in its currency. */
  lineFilter: Record<string, unknown>;
}

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
    private readonly moved: MovedTables,
    private readonly store: DocumentStoreService,
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
      lineSums(this.store, org.id, { entry: { status: 'POSTED' }, line: { accountId: { $in: ids } }, by: { accountId: 'lines.accountId', currency: 'lines.currency' } }).then((r) =>
        r.map((x) => ({ account_id: x.key.accountId as string, currency: x.key.currency as string, net: x.debit.minus(x.credit), txNet: x.txDebit.minus(x.txCredit) })),
      ),
      Promise.all([
        this.prisma.bankStatementLine.groupBy({ by: ['accountId'], where: { orgId: org.id }, _count: true, _max: { date: true } }),
        this.prisma.bankStatementLine.groupBy({ by: ['accountId'], where: { orgId: org.id, status: 'UNMATCHED' }, _count: true }),
      ]).then(([all, open]) => all.map((g) => ({ account_id: g.accountId, total: g._count, unmatched: open.find((o) => o.accountId === g.accountId)?._count ?? 0, last_date: g._max.date }))),
      this.prisma.bankReconciliation.findMany({ where: { orgId: org.id, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } }),
    ]);
    const fscale = minorUnits(org.functionalCurrency);
    return accounts.map((a) => {
      const l = lines.find((x) => x.account_id === a.id);
      const r = recs.find((x) => x.accountId === a.id);
      const b = this.bookOf(org, a);
      const mine = ledger.filter((x) => x.account_id === a.id);
      const functional = mine.reduce((s, x) => s.plus(x.net), new D(0));
      const own = b.foreign ? mine.filter((x) => x.currency === b.currency).reduce((s, x) => s.plus(x.txNet), new D(0)) : functional;
      const scale = b.scale;
      return {
        id: a.id,
        code: a.code,
        name: a.name,
        subtype: a.subtype,
        isActive: a.isActive,
        currency: b.currency,
        /** In the account's currency; `functionalBalance` is what the books carry for it. */
        ledgerBalance: own.toFixed(scale),
        functionalBalance: functional.toFixed(fscale),
        statementLines: Number(l?.total ?? 0),
        unmatchedLines: Number(l?.unmatched ?? 0),
        lastStatementDate: l?.last_date ? fromDbDate(l.last_date) : null,
        lastReconciled: r ? { date: fromDbDate(r.statementDate), statementBalance: r.statementBalance.toFixed(scale) } : null,
      };
    });
  }

  // --------------------------------------------------------------- import

  async importStatement(org: BankOrg, actor: Actor, accountId: string, input: { fileName: string; csv: string; format?: StatementFormat; mapping?: StatementMapping; dateFormat?: DateFormat; dryRun: boolean }) {
    const account = await this.bankAccount(this.prisma, org.id, accountId);
    const book = this.bookOf(org, account);
    const format = input.format ?? 'CSV';
    let file: StatementFile | null = null;
    let parsed: ParsedStatementLine[];
    if (format === 'CSV') parsed = parseStatement(input.csv, input.mapping!, book.currency);
    else {
      if (detectStatementFormat(input.csv) !== format) throw new StatementImportError([`This file does not look like ${format}`]);
      file = parseStatementFile(format, input.csv, book.currency, input.dateFormat);
      parsed = file.lines;
    }
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
    const scale = book.scale;
    const check = balanceBreaks(parsed);
    const totals = file ? fileTotalsCheck(file) : null;
    const fileTotals = totals ? { opening: totals.opening.toFixed(scale), closing: totals.closing.toFixed(scale), computed: totals.computed.toFixed(scale), difference: totals.difference.toFixed(scale) } : null;
    const balanceCheck = format !== 'CSV' || input.mapping?.balance == null ? null : {
      checked: check.checked,
      order: check.order,
      breaks: check.breaks.map((b) => ({ row: b.row, previousRow: b.previousRow, date: b.date, previousDate: b.previousDate, expected: b.expected.toFixed(scale), shown: b.shown.toFixed(scale), gap: b.gap.toFixed(scale) })),
    };
    const preview = (r: Awaited<ReturnType<typeof run>>) => ({
      accountId,
      currency: book.currency,
      format,
      fileTotals,
      balanceCheck,
      lines: r.rows.map((x) => ({ row: x.row, date: x.date, description: x.description, reference: x.reference, amount: x.amount.toFixed(scale), balance: x.balance ? x.balance.toFixed(scale) : null, duplicate: x.duplicate })),
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
      const imp = await this.moved.create<Prisma.BankStatementImportGetPayload<object>>(tx, BANK_IMPORTS, org.id, {
          accountId,
          fileName: input.fileName.slice(0, 200),
          fileHash: sha(input.csv),
          lineCount: r.fresh.length,
          skippedCount: r.rows.length - r.fresh.length,
          firstDate: toDbDate(dates[0]),
          lastDate: toDbDate(dates[dates.length - 1]),
          importedById: actor.id,
          createdAt: new Date(),
          balanceBreaks: balanceCheck ? balanceCheck.breaks.map((b) => ({ row: b.row, previousRow: b.previousRow, date: b.date, previousDate: b.previousDate, gap: b.gap })) : null,
      });
      await this.moved.createMany(tx, BANK_LINES, org.id, r.fresh.map((x) => ({
          accountId,
          importId: imp.id,
          date: toDbDate(x.date),
          description: x.description,
          reference: x.reference,
          amount: x.amount.toFixed(),
          balance: x.balance ? x.balance.toFixed() : null,
          fingerprint: x.fingerprint,
          status: 'UNMATCHED',
          excludedReason: null,
          reconciliationId: null,
          createdAt: new Date(),
        })),
      );
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'bank.statement_imported',
        entityType: 'bank_statement_import',
        entityId: imp.id,
        data: { accountId, currency: book.currency, format, fileName: imp.fileName, fileHash: imp.fileHash, lines: imp.lineCount, skipped: imp.skippedCount, fileTotals, balanceBreaks: balanceCheck ? balanceCheck.breaks.length : null },
      });
      return { imported: true, importId: imp.id, ...preview(r) };
    });
  }

  /**
   * Adds lines that arrived through a bank feed (BANK-004), in one transaction with the account
   * locked. A line whose key is already on the account is skipped as a duplicate; a line on or
   * before the last completed reconciliation is refused (the sender cannot undo a reconciliation);
   * the rest become one import, like an uploaded file. Positions in the result are 0-based indexes
   * into input.lines.
   */
  async importFedLines(
    org: BankOrg,
    input: { accountId: string; importedById: string; fileName: string; fileHash: string; lines: { key: string; date: string; description: string; reference: string | null; amount: Dec; balance?: Dec | null }[]; audit: Record<string, unknown> },
  ): Promise<{ importId: string | null; imported: number[]; duplicates: number[]; blocked: number[]; reconciledUntil: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const account = await this.lockAccount(tx, org.id, input.accountId);
      const book = this.bookOf(org, account);
      const fingerprints = input.lines.map((l) => sha(l.key));
      const existing = new Set(
        fingerprints.length ? (await tx.bankStatementLine.findMany({ where: { orgId: org.id, accountId: input.accountId, fingerprint: { in: fingerprints } }, select: { fingerprint: true } })).map((x) => x.fingerprint) : [],
      );
      const last = await tx.bankReconciliation.findFirst({ where: { orgId: org.id, accountId: input.accountId, status: 'COMPLETED' }, orderBy: { statementDate: 'desc' } });
      const reconciledUntil = last ? fromDbDate(last.statementDate) : null;
      const imported: number[] = [];
      const duplicates: number[] = [];
      const blocked: number[] = [];
      input.lines.forEach((l, i) => {
        if (existing.has(fingerprints[i]!)) duplicates.push(i);
        else if (reconciledUntil && l.date <= reconciledUntil) blocked.push(i);
        else {
          existing.add(fingerprints[i]!);
          imported.push(i);
        }
      });
      if (!imported.length) return { importId: null, imported, duplicates, blocked, reconciledUntil };
      const fresh = imported.map((i) => ({ ...input.lines[i]!, fingerprint: fingerprints[i]! }));
      const dates = fresh.map((x) => x.date).sort();
      const imp = await this.moved.create<Prisma.BankStatementImportGetPayload<object>>(tx, BANK_IMPORTS, org.id, {
        accountId: input.accountId,
        fileName: input.fileName.slice(0, 200),
        fileHash: input.fileHash,
        lineCount: fresh.length,
        skippedCount: duplicates.length + blocked.length,
        firstDate: toDbDate(dates[0]!),
        lastDate: toDbDate(dates[dates.length - 1]!),
        importedById: input.importedById,
        createdAt: new Date(),
        balanceBreaks: null,
      });
      await this.moved.createMany(tx, BANK_LINES, org.id, fresh.map((x) => ({
        accountId: input.accountId,
        importId: imp.id,
        date: toDbDate(x.date),
        description: x.description.slice(0, 500),
        reference: x.reference,
        amount: x.amount.toFixed(),
        balance: x.balance ? x.balance.toFixed() : null,
        fingerprint: x.fingerprint,
        status: 'UNMATCHED',
        excludedReason: null,
        reconciliationId: null,
        createdAt: new Date(),
      })));
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: null,
        action: 'bank.feed_lines_imported',
        entityType: 'bank_statement_import',
        entityId: imp.id,
        data: { ...input.audit, accountId: input.accountId, currency: book.currency, lines: fresh.length, duplicates: duplicates.length, refusedAsReconciled: blocked.length },
      });
      return { importId: imp.id, imported, duplicates, blocked, reconciledUntil };
    }, { timeout: 20_000 });
  }

  /** The currency of a bank account's statements, for checking what a feed sends. */
  async accountCurrency(org: BankOrg, accountId: string) {
    const a = await this.bankAccount(this.prisma, org.id, accountId);
    return { code: a.code, name: a.name, currency: this.bookOf(org, a).currency, isActive: a.isActive };
  }

  async listImports(org: BankOrg, accountId: string) {
    await this.bankAccount(this.prisma, org.id, accountId);
    const rows = await this.prisma.bankStatementImport.findMany({ where: { orgId: org.id, accountId }, orderBy: { createdAt: 'desc' }, take: 100 });
    const breaks = new Map((await runInOrg(org.id, () => this.store.collection(bankStatementImports).find({ id: { $in: rows.map((r) => r.id) } }, { projection: { id: 1, balanceBreaks: 1 } }))).map((d) => [d.id, d.balanceBreaks ?? null]));
    const scale = minorUnits(org.functionalCurrency);
    return rows.map((i) => ({
      /** Null when the file had no balance column. */
      balanceBreaks: breaks.get(i.id)?.map((b) => ({ ...b, gap: new D(b.gap).toFixed(scale) })) ?? null,
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
    const book = await this.book(this.prisma, org, line.accountId);
    const rows = await this.unmatchedLedgerLines(this.prisma, org.id, line.accountId, {
      from: addDay(fromDbDate(line.date), -90),
      to: addDay(fromDbDate(line.date), 90),
      search: q.search,
    }, book);
    const target = new D(line.amount.toString());
    const day = Date.parse(fromDbDate(line.date));
    rows.sort((a, b) => {
      const da = new D(a.net.toString()).minus(target).abs().cmp(new D(b.net.toString()).minus(target).abs());
      if (da) return da;
      return Math.abs(Date.parse(fromDbDate(a.date)) - day) - Math.abs(Date.parse(fromDbDate(b.date)) - day);
    });
    return rows.slice(0, 100).map((r) => this.serializeLedgerLine(r, book.scale));
  }

  async match(org: BankOrg, actor: Actor, lineId: string, journalLineIds: string[], outer?: Tx) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      await this.matchInTx(tx, org, actor, line, journalLineIds, 'EXISTING');
      return this.reload(tx, org, lineId);
    }, outer);
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
      await this.moved.updateMany(tx, BANK_MATCHES, org.id, { statementLineId: lineId, removedAt: null }, { removedAt: now, removedById: actor.id });
      await this.moved.update(tx, BANK_LINES, org.id, lineId, { status: 'UNMATCHED' });
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
  async createEntry(org: BankOrg, actor: Actor, lineId: string, input: { accountId: string; description?: string }, outer?: Tx) {
    this.require(org, 'journals.post', 'post entries from bank lines');
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      if (input.accountId === line.accountId) throw new DomainError('INVALID_ACCOUNT', 'Choose the account on the other side of the bank line, not the bank account itself');
      const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
      if (input.accountId === o.arAccountId || input.accountId === o.apAccountId || input.accountId === o.claimsAccountId) {
        throw new DomainError('CONTROL_ACCOUNT', 'Money from customers or to vendors goes through "Record a receipt / payment" so it reaches the right invoice or bill');
      }
      const amount = new D(line.amount.toString());
      const abs = amount.abs().toFixed();
      const text = (input.description?.trim() || line.description).slice(0, 500);
      // In an account kept in another currency both sides are in it, at the day's recorded rate.
      const book = await this.book(tx, org, line.accountId);
      const ccy = book.foreign ? { currency: book.currency } : {};
      const bankSide = { accountId: line.accountId, description: text, ...ccy, ...(amount.gt(0) ? { debit: abs } : { credit: abs }) };
      const otherSide = { accountId: input.accountId, description: text, ...ccy, ...(amount.gt(0) ? { credit: abs } : { debit: abs }) };
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
    }, outer);
  }

  // ------------------------------------------------------------ transfers

  /**
   * Unmatched statement lines that look like money moved between two of the organisation's own
   * bank or cash accounts (BANK-007): the same amount out of one and into another within a few days.
   */
  async transferSuggestions(org: BankOrg) {
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, subtype: { in: BANK_SUBTYPES }, isPostable: true, isActive: true }, select: { id: true, code: true, name: true, currency: true } });
    const ccyOf = new Map(accounts.map((a) => [a.id, a.currency ?? org.functionalCurrency]));
    if (accounts.length < 2) return { items: [] };
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { orgId: org.id, status: 'UNMATCHED', reconciliationId: null, accountId: { in: accounts.map((a) => a.id) } },
      orderBy: { date: 'desc' },
      take: 2000,
    });
    // The same amount only means a transfer between accounts in the same currency.
    const found = suggestTransfers(
      lines.map((l) => ({ id: l.id, accountId: l.accountId, date: fromDbDate(l.date), amount: new D(l.amount.toString()), text: `${l.description} ${l.reference ?? ''}` })),
      accounts.map((a) => ({ id: a.id, code: a.code, name: a.name })),
    ).filter((f) => ccyOf.get(lines.find((l) => l.id === f.outLineId)!.accountId) === ccyOf.get(lines.find((l) => l.id === f.inLineId)!.accountId));
    const byLine = new Map(lines.map((l) => [l.id, l]));
    const label = new Map(accounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
    const side = (id: string) => {
      const l = byLine.get(id)!;
      return { id, accountId: l.accountId, account: label.get(l.accountId)!, date: fromDbDate(l.date), description: l.description, reference: l.reference };
    };
    return {
      items: found.map((f) => ({ amount: new D(byLine.get(f.inLineId)!.amount.toString()).toFixed(minorUnits(ccyOf.get(byLine.get(f.inLineId)!.accountId)!)), currency: ccyOf.get(byLine.get(f.inLineId)!.accountId)!, days: f.days, score: f.score, reasons: f.reasons, unique: f.unique, out: side(f.outLineId), in: side(f.inLineId) })),
    };
  }

  /**
   * Records a transfer between two own accounts from its two statement lines: one entry
   * (Dr receiving account / Cr paying account, dated when the money left) matched to both.
   */
  async recordTransfer(org: BankOrg, actor: Actor, input: { outLineId: string; inLineId: string }) {
    this.require(org, 'journals.post', 'record transfers');
    return this.inTx(async (tx) => {
      if (input.outLineId === input.inLineId) throw new DomainError('INVALID_TRANSFER', 'Choose two different statement lines');
      const locked = new Map<string, Awaited<ReturnType<BankingService['lockLine']>>>();
      for (const id of [input.outLineId, input.inLineId].sort()) locked.set(id, await this.lockLine(tx, org.id, id));
      const out = locked.get(input.outLineId)!;
      const into = locked.get(input.inLineId)!;
      this.assertOpen(out);
      this.assertOpen(into);
      const [outAmount, inAmount] = [new D(out.amount.toString()), new D(into.amount.toString())];
      const issues: string[] = [];
      if (out.accountId === into.accountId) issues.push('A transfer moves money between two different accounts');
      if (!outAmount.lt(0)) issues.push('The first line must be money out');
      if (!inAmount.gt(0)) issues.push('The second line must be money in');
      if (!outAmount.neg().eq(inAmount)) issues.push('Money out and money in must be the same amount');
      const gap = Math.abs(out.date.getTime() - into.date.getTime()) / 86_400_000;
      if (gap > 31) issues.push('The two lines are more than 31 days apart');
      if (issues.length) throw new DomainError('INVALID_TRANSFER', issues.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
      const [from, to] = [await this.bankAccount(tx, org.id, out.accountId), await this.bankAccount(tx, org.id, into.accountId)];
      const [fromBook, toBook] = [this.bookOf(org, from), this.bookOf(org, to)];
      if (fromBook.currency !== toBook.currency) {
        throw new DomainError('INVALID_TRANSFER', `${from.code} is in ${fromBook.currency} and ${to.code} in ${toBook.currency}; money changed between currencies is not a same-amount transfer. Record each side as its own entry.`);
      }
      const ccy = fromBook.foreign ? { currency: fromBook.currency } : {};
      const amount = inAmount.toFixed();
      const memo = `Transfer ${from.code} ${from.name} → ${to.code} ${to.name}`;
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: fromDbDate(out.date),
        source: 'BANK',
        memo,
        reference: out.reference ?? into.reference ?? undefined,
        lines: [
          { accountId: to.id, debit: amount, description: into.description.slice(0, 500), ...ccy },
          { accountId: from.id, credit: amount, description: out.description.slice(0, 500), ...ccy },
        ],
      });
      const jl = await tx.journalLine.findMany({ where: { entryId: je.id } });
      await this.matchInTx(tx, org, actor, out, [jl.find((l) => l.accountId === from.id)!.id], 'CREATED_ENTRY');
      await this.matchInTx(tx, org, actor, into, [jl.find((l) => l.accountId === to.id)!.id], 'CREATED_ENTRY');
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.transfer_recorded', entityType: 'journal_entry', entityId: je.id, data: { outLineId: out.id, inLineId: into.id, fromAccountId: from.id, toAccountId: to.id, amount } });
      return { journalEntryId: je.id, out: await this.reload(tx, org, out.id), in: await this.reload(tx, org, into.id) };
    });
  }

  /** Records a customer receipt (money in) or vendor payment (money out) for the line and matches it. */
  async recordPayment(org: BankOrg, actor: Actor, lineId: string, input: { contactId: string; allocations: { documentId: string; amount: string }[]; memo?: string }, outer?: Tx) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      const amount = new D(line.amount.toString());
      const ledger: Ledger = amount.gt(0) ? 'SALES' : 'PURCHASES';
      this.require(org, ledger === 'SALES' ? 'sales.manage' : 'purchases.manage', ledger === 'SALES' ? 'record receipts' : 'record payments');
      const book = await this.book(tx, org, line.accountId);
      const p = await this.documents.recordPaymentInTx(tx, org, actor, ledger, {
        contactId: input.contactId,
        date: fromDbDate(line.date),
        bankAccountId: line.accountId,
        ...(book.foreign ? { currency: book.currency } : {}),
        amount: amount.abs().toFixed(),
        reference: line.reference ?? line.description.slice(0, 100),
        memo: input.memo ?? null,
        allocations: input.allocations,
      });
      const bankLine = await tx.journalLine.findFirstOrThrow({ where: { entryId: p.journalEntryId, accountId: line.accountId } });
      await this.matchInTx(tx, org, actor, line, [bankLine.id], 'CREATED_PAYMENT');
      return this.reload(tx, org, lineId);
    }, outer);
  }

  async exclude(org: BankOrg, actor: Actor, lineId: string, reason: string) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      this.assertOpen(line);
      await this.moved.update(tx, BANK_LINES, org.id, lineId, { status: 'EXCLUDED', excludedReason: reason });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.line_excluded', entityType: 'bank_statement_line', entityId: lineId, data: { reason } });
      return this.reload(tx, org, lineId);
    });
  }

  async include(org: BankOrg, actor: Actor, lineId: string) {
    return this.inTx(async (tx) => {
      const line = await this.lockLine(tx, org.id, lineId);
      if (line.status !== 'EXCLUDED') throw new DomainError('NOT_EXCLUDED', 'This statement line is not excluded', HttpStatus.CONFLICT);
      if (line.reconciliationId) throw new DomainError('LINE_RECONCILED', 'This line is reconciled; undo the reconciliation first', HttpStatus.CONFLICT);
      await this.moved.update(tx, BANK_LINES, org.id, lineId, { status: 'UNMATCHED', excludedReason: null });
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
      const rec = await this.moved.create<Prisma.BankReconciliationGetPayload<object>>(tx, BANK_RECONCILIATIONS, org.id, {
          accountId,
          startDate: toDbDate(f.startDate),
          statementDate: toDbDate(f.statementDate),
          openingBalance: f.openingBalance,
          statementBalance: f.statementBalance,
          ledgerBalance: f.ledgerBalance,
          uncleared: f.uncleared,
          completedById: actor.id,
          completedAt: new Date(),
          status: 'COMPLETED',
          undoneById: null,
          undoneAt: null,
          undoReason: null,
      });
      const updated = { count: await this.moved.updateMany(tx, BANK_LINES, org.id, { accountId, reconciliationId: null, date: { $gte: toDbDate(f.startDate), $lte: toDbDate(f.statementDate) } }, { reconciliationId: rec.id }) };
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'bank.reconciled',
        entityType: 'bank_reconciliation',
        entityId: rec.id,
        data: { accountId, statementDate: f.statementDate, statementBalance: f.statementBalance, ledgerBalance: f.ledgerBalance, uncleared: f.uncleared, lines: updated.count },
      });
      return this.serializeReconciliation(rec, updated.count, (await this.book(tx, org, accountId)).scale);
    });
  }

  async listReconciliations(org: BankOrg, accountId: string) {
    const book = this.bookOf(org, await this.bankAccount(this.prisma, org.id, accountId));
    const recs = await this.prisma.bankReconciliation.findMany({
      where: { orgId: org.id, accountId },
      orderBy: [{ statementDate: 'desc' }, { completedAt: 'desc' }],
      include: { _count: { select: { lines: true } } },
    });
    return recs.map((r) => this.serializeReconciliation(r, r._count.lines, book.scale));
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
      const released = { count: await this.moved.updateMany(tx, BANK_LINES, org.id, { reconciliationId: id }, { reconciliationId: null }) };
      const done = (await this.moved.update<Prisma.BankReconciliationGetPayload<object>>(tx, BANK_RECONCILIATIONS, org.id, id, { status: 'UNDONE', undoneAt: new Date(), undoneById: actor.id, undoReason: reason }))!;
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.reconciliation_undone', entityType: 'bank_reconciliation', entityId: id, data: { reason, lines: released.count } });
      return this.serializeReconciliation(done, 0, (await this.book(tx, org, rec.accountId)).scale);
    });
  }

  // ------------------------------------------------------------- internals

  private async figures(db: Tx | PrismaService, org: BankOrg, accountId: string, input: { statementDate: string; statementBalance: string; openingBalance?: string }) {
    const book = await this.book(db, org, accountId);
    const scale = book.scale;
    const statementDate = input.statementDate;
    const statementBalance = this.amount(scale, input.statementBalance, 'Statement balance');
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
      if (input.openingBalance !== undefined && !this.amount(scale, input.openingBalance, 'Opening balance').eq(openingBalance)) {
        throw new DomainError('OPENING_MISMATCH', `The opening balance is the last reconciled balance, ${openingBalance.toFixed(scale)}`);
      }
    } else {
      if (input.openingBalance === undefined) throw new DomainError('OPENING_REQUIRED', 'Enter the opening balance shown on the first statement');
      openingBalance = this.amount(scale, input.openingBalance, 'Opening balance');
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

    // A foreign account's ledger balance is in its own currency: the amounts of its lines in it.
    const [bal] = await lineSums(this.store, org.id, { entry: postedBetween(null, toDbDate(statementDate)), line: book.lineFilter, by: {} });
    const ledgerBalance = bal ? (book.foreign ? bal.txDebit.minus(bal.txCredit) : bal.debit.minus(bal.credit)) : new D(0);

    const onAccount = await ledgerLines(this.store, org.id, { entry: postedBetween(null, toDbDate(statementDate)), line: book.lineFilter });
    const matchedOn = await this.activeMatchDates(db, org.id, onAccount.map((l) => l.id));
    const cutoff = toDbDate(statementDate);
    const before = toDbDate(clearedBefore);
    const uncleared = onAccount
      .filter((l) => {
        const dates = matchedOn.get(l.id) ?? [];
        if (dates.some((d) => d <= cutoff)) return false;
        return l.date >= before || dates.length > 0;
      })
      .map((l) => toRow(l, book.foreign));
    const outstanding = dropReversalPairs(uncleared);
    const unclearedTotal = outstanding.reduce((s, r) => s.plus(r.net.toString()), new D(0));

    const f = { computedStatementBalance: openingBalance.plus(movement), statementBalance, ledgerBalance, uncleared: unclearedTotal };
    const issues = reconciliationIssues(f, unmatched.length);
    if (statementDate > todayIso()) issues.unshift('The statement date cannot be in the future');
    return {
      currency: book.currency,
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
      unclearedLines: outstanding.map((r) => this.serializeLedgerLine(r, scale)),
      firstReconciliation: !prev,
      issues,
      canComplete: issues.length === 0,
    };
  }

  private async matchInTx(tx: Tx, org: BankOrg, actor: Actor, line: Awaited<ReturnType<BankingService['lockLine']>>, journalLineIds: string[], origin: 'EXISTING' | 'CREATED_ENTRY' | 'CREATED_PAYMENT') {
    this.assertOpen(line);
    const ids = [...new Set(journalLineIds)];
    if (!ids.length) throw new DomainError('INVALID_MATCH', 'Choose at least one ledger line');
    // The lines are locked, so two matches of one line take turns.
    for (const id of [...ids].sort()) await holdLock(`journal_lines:${id}`);
    const found = await ledgerLines(this.store, org.id, { line: { id: { $in: ids } } });
    const active = await this.activeMatchDates(tx, org.id, ids);
    const book = await this.book(tx, org, line.accountId);
    const rows = found.map((l) => ({ id: l.id, account_id: l.account_id, status: l.status, currency: l.currency, net: book.foreign ? l.tx_net : l.net, matched: (active.get(l.id) ?? []).length > 0 }));
    const issues: string[] = [];
    if (rows.length !== ids.length) issues.push('Some ledger lines were not found');
    for (const r of rows) {
      if (r.account_id !== line.accountId) issues.push('Every ledger line must be on this bank account');
      else if (book.foreign && r.currency !== book.currency) issues.push(`This account's statements are in ${book.currency}; a line in ${r.currency} is not on them`);
      else if (r.status !== 'POSTED') issues.push('Only posted ledger lines can be matched');
      else if (r.matched) issues.push('A chosen ledger line is already matched to another statement line');
    }
    const total = rows.reduce((s, r) => s.plus(r.net.toString()), new D(0));
    const amount = new D(line.amount.toString());
    if (!issues.length && !total.eq(amount)) {
      issues.push(`The chosen ledger lines add up to ${total.toFixed(book.scale)}, not ${amount.toFixed(book.scale)}`);
    }
    if (issues.length) throw new DomainError('INVALID_MATCH', [...new Set(issues)].join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues: [...new Set(issues)] });
    await this.moved.createMany(tx, BANK_MATCHES, org.id, ids.map((journalLineId) => ({ statementLineId: line.id, journalLineId, origin, createdById: actor.id, createdAt: new Date(), removedAt: null, removedById: null })));
    await this.moved.update(tx, BANK_LINES, org.id, line.id, { status: 'MATCHED' });
    await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.line_matched', entityType: 'bank_statement_line', entityId: line.id, data: { journalLineIds: ids, origin } });
  }

  async suggestionsFor(db: Tx | PrismaService, org: BankOrg, accountId: string, lines: { id: string; date: Date; amount: Prisma.Decimal; description: string; reference: string | null }[]) {
    const dates = lines.map((l) => fromDbDate(l.date)).sort();
    const ledger = await this.unmatchedLedgerLines(db, org.id, accountId, { from: addDay(dates[0], -14), to: addDay(dates[dates.length - 1], 14) }, await this.book(db, org, accountId));
    const [who, learned] = await Promise.all([this.counterparties(db, org.id, accountId, ledger.map((r) => ({ id: r.id, entryId: r.entry_id }))), this.learnedMatches(db, org.id, accountId)]);
    return suggestMatches(
      lines.map((l) => ({ id: l.id, date: fromDbDate(l.date), amount: new D(l.amount.toString()), text: `${l.description} ${l.reference ?? ''}` })),
      ledger.map((r) => ({ id: r.id, date: fromDbDate(r.date), amount: new D(r.net.toString()), text: `${r.memo ?? ''} ${r.reference ?? ''} ${r.description ?? ''}`, counterparty: who.get(r.id)?.key ?? null })),
      learned,
    );
  }

  /** What matching on this account has learned from past matches (BANK-017). */
  async matchPatterns(org: BankOrg, accountId: string) {
    await this.bankAccount(this.prisma, org.id, accountId);
    const learned = await this.learnedMatches(this.prisma, org.id, accountId);
    return { decisions: learned.length, patterns: learnedPatterns(learned).slice(0, 50) };
  }

  /**
   * Past matches on the account, newest first: each statement line's text with who its ledger
   * line was with. A match later undone counts against that counterparty, unless the same line
   * is matched to that counterparty again now (an unmatch to fix a detail, not a wrong match).
   */
  private async learnedMatches(db: Tx | PrismaService, orgId: string, accountId: string): Promise<LearnedMatch[]> {
    const matches = (
      await db.bankMatch.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: LEARN_FROM_MATCHES, include: { statementLine: true, journalLine: true } })
    ).filter((m) => m.statementLine.accountId === accountId);
    if (!matches.length) return [];
    const who = await this.counterparties(db, orgId, accountId, matches.map((m) => ({ id: m.journalLineId, entryId: m.journalLine.entryId })));
    const byPair = new Map<string, LearnedMatch>();
    for (const m of matches) {
      const c = who.get(m.journalLineId);
      if (!c) continue;
      const key = `${m.statementLineId}\u0001${c.key}`;
      const kept = m.removedAt == null;
      const cur = byPair.get(key);
      if (!cur) byPair.set(key, { text: `${m.statementLine.description} ${m.statementLine.reference ?? ''}`, counterparty: c.key, label: c.label, kept });
      else if (kept) cur.kept = true;
    }
    return [...byPair.values()];
  }

  /**
   * Who each ledger line is with: the contact on its payment, or else the account on the
   * entry's largest other line (bank charges, rent, a transfer).
   */
  private async counterparties(db: Tx | PrismaService, orgId: string, bankAccountId: string, lines: { id: string; entryId: string }[]) {
    const out = new Map<string, { key: string; label: string }>();
    if (!lines.length) return out;
    const entryIds = [...new Set(lines.map((l) => l.entryId))];
    const [payments, others] = await Promise.all([
      db.payment.findMany({ where: { orgId, journalEntryId: { in: entryIds } }, include: { contact: { select: { id: true, name: true } } } }),
      db.journalLine.findMany({ where: { entryId: { in: entryIds } } }),
    ]);
    const paidBy = new Map(payments.map((p) => [p.journalEntryId, p.contact]));
    const offset = new Map<string, { accountId: string; size: Dec }>();
    for (const l of others) {
      if (l.accountId === bankAccountId) continue;
      const size = new D(l.functionalDebit.toString()).plus(l.functionalCredit.toString());
      const cur = offset.get(l.entryId);
      if (!cur || size.gt(cur.size)) offset.set(l.entryId, { accountId: l.accountId, size });
    }
    const accountIds = [...new Set([...offset.values()].map((o) => o.accountId))];
    const names = new Map((accountIds.length ? await db.account.findMany({ where: { orgId, id: { in: accountIds } }, select: { id: true, name: true } }) : []).map((a) => [a.id, a.name]));
    for (const l of lines) {
      const contact = paidBy.get(l.entryId);
      if (contact) out.set(l.id, { key: `contact:${contact.id}`, label: contact.name });
      else {
        const o = offset.get(l.entryId);
        if (o) out.set(l.id, { key: `account:${o.accountId}`, label: names.get(o.accountId) ?? 'another account' });
      }
    }
    return out;
  }

  async unmatchedLedgerLines(db: Tx | PrismaService, orgId: string, accountId: string, q: { from: string; to: string; search?: string }, book?: Book) {
    const term = q.search?.trim().toLowerCase();
    const lines = await ledgerLines(this.store, orgId, { entry: postedBetween(toDbDate(q.from), toDbDate(q.to)), line: book?.lineFilter ?? { accountId } });
    const matched = await this.activeMatchDates(db, orgId, lines.map((l) => l.id));
    return lines
      .filter((l) => !matched.has(l.id))
      .filter((l) => !term || [l.memo, l.reference, l.description].some((t) => t?.toLowerCase().includes(term)))
      .slice(0, 1000)
      .map((l) => toRow(l, !!book?.foreign));
  }

  /**
   * Everything still unmatched on one bank account, for exception analysis (BANK-020): statement
   * lines not matched or excluded, and entries in the books not matched to a statement line since
   * reconciliations began (or since the first statement line), in the account's currency.
   */
  async unmatchedItems(org: BankOrg, accountId: string, today = todayIso()) {
    const book = await this.book(this.prisma, org, accountId);
    const [firstRec, firstLine, lastLine, lines] = await Promise.all([
      this.prisma.bankReconciliation.findFirst({ where: { orgId: org.id, accountId, status: 'COMPLETED' }, orderBy: { statementDate: 'asc' } }),
      this.prisma.bankStatementLine.findFirst({ where: { orgId: org.id, accountId }, orderBy: { date: 'asc' } }),
      this.prisma.bankStatementLine.findFirst({ where: { orgId: org.id, accountId }, orderBy: { date: 'desc' } }),
      this.prisma.bankStatementLine.findMany({ where: { orgId: org.id, accountId, status: 'UNMATCHED' }, orderBy: [{ date: 'asc' }, { id: 'asc' }], select: { id: true, date: true, amount: true, description: true, reference: true } }),
    ]);
    const from = firstRec ? fromDbDate(firstRec.startDate) : firstLine ? fromDbDate(firstLine.date) : null;
    const ledger = from ? await this.unmatchedLedgerLines(this.prisma, org.id, accountId, { from, to: today }, book) : [];
    return {
      currency: book.currency,
      scale: book.scale,
      since: from,
      lastStatementDate: lastLine ? fromDbDate(lastLine.date) : null,
      statement: lines.map((l) => ({ id: l.id, date: fromDbDate(l.date), amount: new D(l.amount.toString()).toFixed(book.scale), text: [l.description, l.reference].filter(Boolean).join(' · ') })),
      book: ledger.map((r) => ({ id: r.id, date: fromDbDate(r.date), amount: new D(r.net.toString()).toFixed(book.scale), text: [entryNo(r.entry_number), r.memo, r.reference, r.description].filter(Boolean).join(' · '), entryId: r.entry_id })),
    };
  }

  /** For each journal line, the statement dates of the bank matches on it that are not removed. */
  private async activeMatchDates(db: Tx | PrismaService, orgId: string, journalLineIds: string[]) {
    const out = new Map<string, Date[]>();
    if (!journalLineIds.length) return out;
    const matches = await db.bankMatch.findMany({ where: { orgId, journalLineId: { in: journalLineIds }, removedAt: null }, select: { journalLineId: true, statementLine: { select: { date: true } } } });
    for (const m of matches) out.set(m.journalLineId, [...(out.get(m.journalLineId) ?? []), m.statementLine.date]);
    return out;
  }

  private async serializeLines(
    db: Tx | PrismaService,
    org: BankOrg,
    lines: { id: string; accountId: string; date: Date; description: string; reference: string | null; amount: Prisma.Decimal; status: string; excludedReason: string | null; reconciliationId: string | null; importId: string }[],
    suggestions: ReturnType<typeof suggestMatches>,
  ) {
    const books = new Map<string, Book>();
    for (const a of [...new Set(lines.map((l) => l.accountId))]) books.set(a, await this.book(db, org, a));
    const ids = lines.map((l) => l.id);
    const matches = ids.length
      ? await db.bankMatch.findMany({
          where: { statementLineId: { in: ids }, removedAt: null },
          include: { journalLine: { include: { entry: true } } },
        })
      : [];
    const entryIds = [...new Set([...matches.map((m) => m.journalLine.entryId)])];
    // Files attached to each line (receipts, bank advices), counted without their bytes.
    const files = ids.length ? await db.attachment.findMany({ where: { orgId: org.id, entityType: 'BANK_STATEMENT_LINE', entityId: { in: ids }, removedAt: null }, select: { entityId: true } }) : [];
    const suggested = suggestions.length
      ? await db.journalLine.findMany({ where: { id: { in: suggestions.map((s) => s.journalLineId) } }, include: { entry: true } })
      : [];
    const payments = await db.payment.findMany({
      where: { orgId: org.id, journalEntryId: { in: [...entryIds, ...suggested.map((s) => s.entryId)] } },
      include: { contact: { select: { name: true } } },
    });
    const link = (l: { id: string; entryId: string; debit: Prisma.Decimal; credit: Prisma.Decimal; functionalDebit: Prisma.Decimal; functionalCredit: Prisma.Decimal; description: string | null; entry: { entryNumber: number | null; date: Date; memo: string | null; reference: string | null; source: string } }, book: Book) => {
      const p = payments.find((x) => x.journalEntryId === l.entryId);
      const [dr, cr] = book.foreign ? [l.debit, l.credit] : [l.functionalDebit, l.functionalCredit];
      return {
        journalLineId: l.id,
        entryId: l.entryId,
        entryNumber: entryNo(l.entry.entryNumber),
        date: fromDbDate(l.entry.date),
        memo: l.entry.memo,
        reference: l.entry.reference,
        source: l.entry.source,
        amount: new D(dr.toString()).minus(cr.toString()).toFixed(book.scale),
        payment: p ? { id: p.id, number: p.number, kind: p.kind, contactName: p.contact.name } : null,
      };
    };
    return lines.map((l) => {
      const s = suggestions.find((x) => x.statementLineId === l.id);
      const sl = s ? suggested.find((x) => x.id === s.journalLineId) : undefined;
      const book = books.get(l.accountId)!;
      return {
        id: l.id,
        accountId: l.accountId,
        importId: l.importId,
        date: fromDbDate(l.date),
        description: l.description,
        reference: l.reference,
        amount: new D(l.amount.toString()).toFixed(book.scale),
        currency: book.currency,
        status: l.status,
        excludedReason: l.excludedReason,
        reconciled: !!l.reconciliationId,
        matches: matches.filter((m) => m.statementLineId === l.id).map((m) => ({ id: m.id, origin: m.origin, ...link(m.journalLine, book) })),
        suggestion: s && sl ? { ...link(sl, book), score: s.score, reasons: s.reasons, unique: s.unique } : null,
        attachments: files.filter((f) => f.entityId === l.id).length,
      };
    });
  }

  private serializeLedgerLine(r: LedgerLineRow, scale: number) {
    return {
      journalLineId: r.id,
      entryId: r.entry_id,
      entryNumber: entryNo(r.entry_number),
      date: fromDbDate(r.date),
      memo: r.memo,
      reference: r.reference,
      description: r.description,
      source: r.source,
      amount: new D(r.net.toString()).toFixed(scale),
    };
  }

  private serializeReconciliation(
    r: { id: string; accountId: string; startDate: Date; statementDate: Date; openingBalance: Prisma.Decimal; statementBalance: Prisma.Decimal; ledgerBalance: Prisma.Decimal; uncleared: Prisma.Decimal; status: string; completedAt: Date; undoneAt: Date | null; undoReason: string | null },
    lines: number,
    scale: number,
  ) {
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

  private amount(scale: number, v: string, label: string): Dec {
    const n = dec(v);
    if (n.decimalPlaces() > scale) throw new DomainError('INVALID_AMOUNT', `${label} has too many decimal places`);
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

  /** The currency a bank account's statements are in (BANK-012). */
  private bookOf(org: BankOrg, a: { id: string; currency?: string | null }): Book {
    const currency = a.currency ?? org.functionalCurrency;
    const foreign = currency !== org.functionalCurrency;
    return { currency, foreign, scale: minorUnits(currency), lineFilter: foreign ? { accountId: a.id, currency } : { accountId: a.id } };
  }

  private async book(db: Tx | PrismaService, org: BankOrg, accountId: string): Promise<Book> {
    const a = await db.account.findFirst({ where: { id: accountId, orgId: org.id }, select: { id: true, currency: true } });
    return this.bookOf(org, a ?? { id: accountId, currency: null });
  }

  /**
   * Keeps a bank or cash account in another currency, or back in the functional one. Only before
   * anything depends on its currency: no statement lines and no postings in another currency.
   */
  async setCurrency(org: BankOrg, actor: Actor, accountId: string, currencyIn: string | null) {
    this.require(org, 'accounts.manage', 'change the currency of a bank account');
    const currency = currencyIn ? currencyIn.toUpperCase() : null;
    if (currency && !isSupportedCurrency(currency)) throw new DomainError('FX_INVALID', `${currency} is not a supported currency`);
    const keep = currency === org.functionalCurrency ? null : currency;
    return this.inTx(async (tx) => {
      const a = await this.lockAccount(tx, org.id, accountId);
      if ((a.currency ?? null) === keep) return { accountId, currency: keep ?? org.functionalCurrency };
      const issues: string[] = [];
      if (await tx.bankStatementLine.count({ where: { orgId: org.id, accountId } })) issues.push('It has imported statement lines');
      const lines = await ledgerLines(this.store, org.id, { entry: { status: 'POSTED' }, line: { accountId } });
      const other = [...new Set(lines.filter((l) => l.source !== 'FX_REVALUATION' && l.currency !== (keep ?? org.functionalCurrency)).map((l) => l.currency))];
      if (other.length) issues.push(`It has postings in ${other.join(', ')}`);
      if (issues.length) throw new DomainError('CURRENCY_IN_USE', `${a.code} ${a.name} cannot change currency: ${issues.join('; ').toLowerCase()}. Use a new account for the other currency.`, HttpStatus.CONFLICT, { issues });
      await tx.account.update({ where: { id: accountId }, data: { currency: keep } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bank.account_currency_set', entityType: 'account', entityId: accountId, data: { from: a.currency ?? org.functionalCurrency, to: keep ?? org.functionalCurrency } });
      return { accountId, currency: keep ?? org.functionalCurrency };
    });
  }

  /** Serialises imports, auto-matching and reconciliation per bank account. */
  private async lockAccount(tx: Tx, orgId: string, accountId: string) {
    const rows = await lockRow<{ id: string }>(tx, 'accounts', accountId, orgId);
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank account not found' });
    return this.bankAccount(tx, orgId, accountId);
  }

  private async findLine(db: Tx | PrismaService, orgId: string, id: string) {
    const l = await db.bankStatementLine.findFirst({ where: { id, orgId } });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
    return l;
  }

  private async lockLine(tx: Tx, orgId: string, id: string) {
    const rows = await lockRow<{ id: string }>(tx, 'bank_statement_lines', id, orgId);
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
    return tx.bankStatementLine.findUniqueOrThrow({ where: { id } });
  }

  /** A concurrent match of the same ledger line hits the partial unique index; report it plainly. */
  private async inTx<T>(fn: (tx: Tx) => Promise<T>, outer?: Tx): Promise<T> {
    if (outer) return fn(outer);
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
