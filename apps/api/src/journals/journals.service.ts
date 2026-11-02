import { ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildReversalLines, JournalLineInput, minorUnits, NormalizedJournal, PostingAccount, validateJournal } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';

export type CreatableJournalType = 'STANDARD' | 'ADJUSTING' | 'OPENING' | 'CLOSING' | 'RECURRING';

export interface JournalInput {
  date: string;
  type: CreatableJournalType;
  memo?: string;
  reference?: string;
  lines: JournalLineInput[];
}

interface Actor {
  id: string;
}

interface OrgInfo {
  id: string;
  functionalCurrency: string;
}

const ENTRY_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true, type: true } } } },
  reversedBy: { select: { id: true, entryNumber: true } },
} satisfies Prisma.JournalEntryInclude;

type EntryWithLines = Prisma.JournalEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

@Injectable()
export class JournalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------- reads ----------

  async list(orgId: string, q: { status?: 'DRAFT' | 'POSTED'; from?: string; to?: string; accountId?: string; limit: number; offset: number }) {
    const where: Prisma.JournalEntryWhereInput = {
      orgId,
      status: q.status,
      date: { gte: q.from ? toDbDate(q.from) : undefined, lte: q.to ? toDbDate(q.to) : undefined },
      ...(q.accountId ? { lines: { some: { accountId: q.accountId } } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.journalEntry.count({ where }),
      this.prisma.journalEntry.findMany({
        where,
        orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }, { createdAt: 'desc' }],
        take: q.limit,
        skip: q.offset,
        include: ENTRY_INCLUDE,
      }),
    ]);
    return { total, items: rows.map(serialize) };
  }

  async get(orgId: string, id: string) {
    const e = await this.prisma.journalEntry.findFirst({ where: { id, orgId }, include: ENTRY_INCLUDE });
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    return serialize(e);
  }

  // ---------- writes ----------

  /**
   * Create a journal (optionally posting it immediately). With an idempotency key, a retried
   * request returns the original result instead of creating a duplicate; reusing a key with a
   * different payload is rejected.
   */
  async create(org: OrgInfo, actor: Actor, input: JournalInput, opts: { post: boolean; idempotencyKey?: string }) {
    const hash = opts.idempotencyKey ? requestHash({ input, post: opts.post }) : undefined;
    if (opts.idempotencyKey) {
      const replay = await this.findIdempotent(org.id, opts.idempotencyKey, hash!);
      if (replay) return { replayed: true, entry: replay };
    }
    try {
      const entry = await this.prisma.$transaction(async (tx) => {
        const period = await this.lockPeriodForDate(tx, org.id, input.date);
        if (period.status === 'CLOSED' || (opts.post && period.status !== 'OPEN')) {
          throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
        }
        const normalized = await this.validate(tx, org, input.lines, { manual: true });
        const created = await tx.journalEntry.create({
          data: {
            orgId: org.id,
            date: toDbDate(input.date),
            periodId: period.id,
            type: input.type,
            memo: input.memo,
            reference: input.reference,
            functionalCurrency: org.functionalCurrency,
            totalDebit: normalized.totalFunctionalDebit.toFixed(),
            totalCredit: normalized.totalFunctionalCredit.toFixed(),
            idempotencyKey: opts.idempotencyKey,
            idempotencyHash: hash,
            createdById: actor.id,
            lines: { create: lineRows(normalized) },
          },
        });
        if (opts.post) await this.markPosted(tx, org.id, created.id, actor.id);
        await this.audit.append(tx, {
          orgId: org.id,
          actorId: actor.id,
          action: opts.post ? 'journal.created_and_posted' : 'journal.draft_created',
          entityType: 'journal_entry',
          entityId: created.id,
          data: { date: input.date, type: input.type, totalDebit: normalized.totalFunctionalDebit.toFixed(), lines: input.lines.length },
        });
        return tx.journalEntry.findUniqueOrThrow({ where: { id: created.id }, include: ENTRY_INCLUDE });
      });
      return { replayed: false, entry: serialize(entry) };
    } catch (e) {
      // Concurrent duplicate with the same idempotency key: the other request won the race.
      if (opts.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const replay = await this.findIdempotent(org.id, opts.idempotencyKey, hash!);
        if (replay) return { replayed: true, entry: replay };
      }
      throw e;
    }
  }

  async updateDraft(org: OrgInfo, actor: Actor, id: string, input: JournalInput) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockEntry(tx, org.id, id);
      if (existing.status !== 'DRAFT') throw new DomainError('ENTRY_POSTED', 'Posted entries are immutable; reverse them instead', HttpStatus.CONFLICT);
      assertManual(existing);
      const period = await this.lockPeriodForDate(tx, org.id, input.date);
      if (period.status === 'CLOSED') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is CLOSED`, HttpStatus.CONFLICT);
      const normalized = await this.validate(tx, org, input.lines, { manual: true });
      await tx.journalLine.deleteMany({ where: { entryId: id, orgId: org.id } });
      await tx.journalEntry.update({
        where: { id },
        data: {
          date: toDbDate(input.date),
          periodId: period.id,
          type: input.type,
          memo: input.memo ?? null,
          reference: input.reference ?? null,
          totalDebit: normalized.totalFunctionalDebit.toFixed(),
          totalCredit: normalized.totalFunctionalCredit.toFixed(),
          lines: { create: lineRows(normalized) },
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal.draft_updated', entityType: 'journal_entry', entityId: id, data: { date: input.date, lines: input.lines.length } });
      return serialize(await tx.journalEntry.findUniqueOrThrow({ where: { id }, include: ENTRY_INCLUDE }));
    });
  }

  async deleteDraft(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.lockEntry(tx, orgId, id);
      if (existing.status !== 'DRAFT') throw new DomainError('ENTRY_POSTED', 'Posted entries cannot be deleted; reverse them instead', HttpStatus.CONFLICT);
      await tx.journalLine.deleteMany({ where: { entryId: id, orgId } });
      await tx.journalEntry.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'journal.draft_deleted', entityType: 'journal_entry', entityId: id });
    });
  }

  async postDraft(org: OrgInfo, actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockEntry(tx, org.id, id);
      if (existing.status !== 'DRAFT') throw new DomainError('ALREADY_POSTED', 'Entry is already posted', HttpStatus.CONFLICT);
      const period = await this.lockPeriodForDate(tx, org.id, fromDbDate(existing.date));
      if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
      // Re-validate against the chart as it is now (accounts may have been deactivated since drafting).
      const lines = await tx.journalLine.findMany({ where: { entryId: id }, orderBy: { lineNo: 'asc' } });
      await this.validate(
        tx,
        org,
        lines.map((l) => ({ accountId: l.accountId, currency: l.currency, exchangeRate: l.exchangeRate.toFixed(), debit: l.debit.toFixed(), credit: l.credit.toFixed() })),
        { manual: true },
      );
      const entryNumber = await this.markPosted(tx, org.id, id, actor.id);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal.posted', entityType: 'journal_entry', entityId: id, data: { entryNumber } });
      return serialize(await tx.journalEntry.findUniqueOrThrow({ where: { id }, include: ENTRY_INCLUDE }));
    });
  }

  /** Post a reversing entry that exactly offsets a posted entry. The original is never modified. */
  async reverse(org: OrgInfo, actor: Actor, id: string, input: { date: string; memo?: string }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const original = await this.lockEntry(tx, org.id, id);
        // Month-end adjustments are journals a person approved with nothing else attached: reversed like manual ones.
        if (original.source !== 'CLOSE') assertManual(original);
        if (original.status !== 'POSTED') throw new DomainError('NOT_POSTED', 'Only posted entries can be reversed; delete the draft instead', HttpStatus.CONFLICT);
        if (original.type === 'REVERSING') throw new DomainError('IS_REVERSAL', 'A reversing entry cannot itself be reversed; post a new entry instead', HttpStatus.CONFLICT);
        const already = await tx.journalEntry.findFirst({ where: { reversesEntryId: id }, select: { id: true } });
        if (already) throw new DomainError('ALREADY_REVERSED', 'Entry has already been reversed', HttpStatus.CONFLICT, { reversalId: already.id });
        if (input.date < fromDbDate(original.date)) throw new DomainError('INVALID_DATE', 'Reversal date cannot be before the original entry date');
        await this.assertNotBankMatched(tx, id);
        const period = await this.lockPeriodForDate(tx, org.id, input.date);
        if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);

        const originalLines = await tx.journalLine.findMany({ where: { entryId: id }, orderBy: { lineNo: 'asc' } });
        const lines = buildReversalLines(
          originalLines.map((l) => ({
            accountId: l.accountId,
            currency: l.currency,
            exchangeRate: l.exchangeRate.toFixed(),
            debit: l.debit.toFixed(),
            credit: l.credit.toFixed(),
            description: l.description,
            dimensions: (l.dimensions as Record<string, string> | null) ?? null,
          })),
        );
        const normalized = await this.validate(tx, org, lines, { allowInactive: true });
        const created = await tx.journalEntry.create({
          data: {
            orgId: org.id,
            date: toDbDate(input.date),
            periodId: period.id,
            type: 'REVERSING',
            memo: input.memo ?? `Reversal of JE-${original.entryNumber}`,
            reference: original.reference,
            functionalCurrency: org.functionalCurrency,
            totalDebit: normalized.totalFunctionalDebit.toFixed(),
            totalCredit: normalized.totalFunctionalCredit.toFixed(),
            reversesEntryId: id,
            createdById: actor.id,
            lines: { create: lineRows(normalized) },
          },
        });
        const entryNumber = await this.markPosted(tx, org.id, created.id, actor.id);
        await this.audit.append(tx, {
          orgId: org.id,
          actorId: actor.id,
          action: 'journal.reversed',
          entityType: 'journal_entry',
          entityId: id,
          data: { reversalId: created.id, reversalNumber: entryNumber, date: input.date },
        });
        return serialize(await tx.journalEntry.findUniqueOrThrow({ where: { id: created.id }, include: ENTRY_INCLUDE }));
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new DomainError('ALREADY_REVERSED', 'Entry has already been reversed', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }

  // ---------- system entries (sales, purchases, payments) ----------

  /**
   * Post a journal generated by another module inside the caller's transaction.
   * Uses the same period checks, validation, numbering and audit as manual journals.
   */
  async postSystemEntry(
    tx: Tx,
    org: OrgInfo,
    actor: Actor,
    input: { date: string; memo?: string; reference?: string; source: 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE' | 'TAX' | 'PAYROLL' | 'CLOSE' | 'ASSET' | 'DEFERRAL' | 'ACCRUAL'; lines: JournalLineInput[] },
  ): Promise<{ id: string; entryNumber: number }> {
    const period = await this.lockPeriodForDate(tx, org.id, input.date);
    if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
    const normalized = await this.validate(tx, org, input.lines);
    const created = await tx.journalEntry.create({
      data: {
        orgId: org.id,
        date: toDbDate(input.date),
        periodId: period.id,
        type: 'STANDARD',
        source: input.source,
        memo: input.memo,
        reference: input.reference,
        functionalCurrency: org.functionalCurrency,
        totalDebit: normalized.totalFunctionalDebit.toFixed(),
        totalCredit: normalized.totalFunctionalCredit.toFixed(),
        createdById: actor.id,
        lines: { create: lineRows(normalized) },
      },
    });
    const entryNumber = await this.markPosted(tx, org.id, created.id, actor.id);
    await this.audit.append(tx, {
      orgId: org.id,
      actorId: actor.id,
      action: 'journal.system_posted',
      entityType: 'journal_entry',
      entityId: created.id,
      data: { entryNumber, source: input.source, reference: input.reference ?? null },
    });
    return { id: created.id, entryNumber };
  }

  /** Reverse a system journal inside the caller's transaction (used when voiding a document or payment). */
  async reverseSystemEntry(tx: Tx, org: OrgInfo, actor: Actor, entryId: string, input: { date: string; memo: string }): Promise<{ id: string; entryNumber: number }> {
    const original = await this.lockEntry(tx, org.id, entryId);
    if (original.source === 'MANUAL' || original.status !== 'POSTED') throw new DomainError('NOT_SYSTEM_ENTRY', 'Only posted system entries can be reversed here');
    if (input.date < fromDbDate(original.date)) throw new DomainError('INVALID_DATE', 'The void date cannot be before the original date');
    await this.assertNotBankMatched(tx, entryId);
    const period = await this.lockPeriodForDate(tx, org.id, input.date);
    if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
    const originalLines = await tx.journalLine.findMany({ where: { entryId }, orderBy: { lineNo: 'asc' } });
    const lines = buildReversalLines(
      originalLines.map((l) => ({
        accountId: l.accountId,
        currency: l.currency,
        exchangeRate: l.exchangeRate.toFixed(),
        debit: l.debit.toFixed(),
        credit: l.credit.toFixed(),
        description: l.description,
      })),
    );
    const normalized = await this.validate(tx, org, lines, { allowInactive: true });
    const created = await tx.journalEntry.create({
      data: {
        orgId: org.id,
        date: toDbDate(input.date),
        periodId: period.id,
        type: 'REVERSING',
        source: original.source,
        memo: input.memo,
        reference: original.reference,
        functionalCurrency: org.functionalCurrency,
        totalDebit: normalized.totalFunctionalDebit.toFixed(),
        totalCredit: normalized.totalFunctionalCredit.toFixed(),
        reversesEntryId: entryId,
        createdById: actor.id,
        lines: { create: lineRows(normalized) },
      },
    });
    const entryNumber = await this.markPosted(tx, org.id, created.id, actor.id);
    await this.audit.append(tx, {
      orgId: org.id,
      actorId: actor.id,
      action: 'journal.system_reversed',
      entityType: 'journal_entry',
      entityId: entryId,
      data: { reversalId: created.id, reversalNumber: entryNumber, date: input.date },
    });
    return { id: created.id, entryNumber };
  }

  // ---------- helpers ----------

  private async findIdempotent(orgId: string, key: string, hash: string) {
    const e = await this.prisma.journalEntry.findUnique({ where: { orgId_idempotencyKey: { orgId, idempotencyKey: key } }, include: ENTRY_INCLUDE });
    if (!e) return null;
    if (e.idempotencyHash !== hash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return serialize(e);
  }

  /** An entry matched to a bank statement line must be unmatched before it is reversed or voided. */
  private async assertNotBankMatched(tx: Tx, entryId: string) {
    const matched = await tx.bankMatch.count({ where: { removedAt: null, journalLine: { entryId } } });
    if (matched > 0) {
      throw new DomainError('BANK_MATCHED', 'This entry is matched to a bank statement line; unmatch it on the bank reconciliation screen first', HttpStatus.CONFLICT);
    }
  }

  private async lockEntry(tx: Tx, orgId: string, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM journal_entries WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    return tx.journalEntry.findUniqueOrThrow({ where: { id } });
  }

  /** Find the period containing a date and hold it FOR SHARE so it cannot be locked mid-posting. */
  private async lockPeriodForDate(tx: Tx, orgId: string, date: string) {
    const rows = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
      SELECT id, name, status::text AS status FROM fiscal_periods
      WHERE org_id = ${orgId}::uuid AND ${toDbDate(date)}::date BETWEEN start_date AND end_date
      FOR SHARE`;
    if (!rows[0]) {
      throw new DomainError('NO_FISCAL_PERIOD', `No fiscal period covers ${date}. Create the fiscal year first.`);
    }
    return rows[0];
  }

  private async validate(tx: Tx, org: OrgInfo, lines: JournalLineInput[], opts: { allowInactive?: boolean; manual?: boolean } = {}): Promise<NormalizedJournal> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    if (opts.manual) {
      const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
      if (ids.some((id) => id === o.arAccountId || id === o.apAccountId || id === o.claimsAccountId)) {
        throw new DomainError(
          'CONTROL_ACCOUNT',
          'Receivables and payables control accounts only take postings from invoices, bills and payments. Use those, or another account.',
        );
      }
    }
    const accounts = await tx.account.findMany({ where: { orgId: org.id, id: { in: ids } } });
    const map = new Map<string, PostingAccount>(
      accounts.map((a) => [a.id, { id: a.id, code: a.code, type: a.type, isPostable: a.isPostable, isActive: opts.allowInactive ? true : a.isActive }]),
    );
    return validateJournal(lines, { functionalCurrency: org.functionalCurrency, accounts: map });
  }

  private async markPosted(tx: Tx, orgId: string, entryId: string, actorId: string): Promise<number> {
    const [{ value }] = await tx.$queryRaw<{ value: number }[]>`
      INSERT INTO org_counters (org_id, key, value) VALUES (${orgId}::uuid, 'journal_entry', 1)
      ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
      RETURNING value`;
    await tx.journalEntry.update({
      where: { id: entryId },
      data: { status: 'POSTED', entryNumber: value, postedAt: new Date(), postedById: actorId },
    });
    return value;
  }
}

function assertManual(e: { source: string }) {
  if (e.source !== 'MANUAL') {
    throw new DomainError(
      'SYSTEM_ENTRY',
      'This entry was created by an invoice, bill or payment. Void that document instead so the two stay in step.',
      HttpStatus.CONFLICT,
    );
  }
}

/** Nested line rows; org_id is filled from the parent entry through the composite (entry_id, org_id) relation. */
function lineRows(j: NormalizedJournal) {
  return j.lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    currency: l.currency,
    exchangeRate: l.exchangeRate.toFixed(),
    debit: l.debit.toFixed(),
    credit: l.credit.toFixed(),
    functionalDebit: l.functionalDebit.toFixed(),
    functionalCredit: l.functionalCredit.toFixed(),
    description: l.description,
    dimensions: l.dimensions ?? undefined,
  }));
}

function serialize(e: EntryWithLines) {
  const fScale = minorUnits(e.functionalCurrency);
  return {
    id: e.id,
    entryNumber: e.entryNumber,
    displayNumber: e.entryNumber ? `JE-${String(e.entryNumber).padStart(6, '0')}` : null,
    date: fromDbDate(e.date),
    type: e.type,
    source: e.source,
    status: e.status,
    memo: e.memo,
    reference: e.reference,
    functionalCurrency: e.functionalCurrency,
    totalDebit: e.totalDebit.toFixed(fScale),
    totalCredit: e.totalCredit.toFixed(fScale),
    reversesEntryId: e.reversesEntryId,
    reversedBy: e.reversedBy ? { id: e.reversedBy.id, entryNumber: e.reversedBy.entryNumber } : null,
    createdById: e.createdById,
    postedById: e.postedById,
    postedAt: e.postedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
    lines: e.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountCode: l.account.code,
      accountName: l.account.name,
      currency: l.currency,
      exchangeRate: l.exchangeRate.toFixed(),
      debit: l.debit.toFixed(minorUnits(l.currency)),
      credit: l.credit.toFixed(minorUnits(l.currency)),
      functionalDebit: l.functionalDebit.toFixed(fScale),
      functionalCredit: l.functionalCredit.toFixed(fScale),
      description: l.description,
      dimensions: l.dimensions,
    })),
  };
}
