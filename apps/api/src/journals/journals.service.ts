import { ConflictException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildReversalLines, JournalLineInput, minorUnits, NormalizedJournal, PostingAccount, validateJournal } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { checkLineDimensions } from '../dimensions/check';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { isDuplicateKeyError, type ScopedCollection } from '@talk2tax/document-db';
import { randomUUID } from 'node:crypto';
import { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { accounts as accountsColl } from '../db/collections/chart';
import { journalEntries, type JournalEntryDoc } from '../db/collections/ledger';
import { PostgresMirrorService } from '../db/postgres-mirror.service';
import { nextCounter, postgresOff } from '../db/counters';
import { lockRow } from '../db/locks';

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

type EntryWithLines = Omit<JournalEntryDoc, 'lines'> & {
  lines: (JournalEntryDoc['lines'][number] & { account: { code: string; name: string } })[];
  reversedBy: { id: string; entryNumber: number | null } | null;
};

function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

@Injectable()
export class JournalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
  ) {}

  /**
   * MongoDB holds the ledger. Every write happens inside a PostgreSQL transaction, whose MongoDB
   * transaction commits right after it (docs/MONGODB.md › While both databases run), and is
   * copied into that PostgreSQL transaction, where documents, bank matches and reports (not
   * moved yet) point at the entry and its lines.
   */
  private entries<T>(orgId: string, fn: (c: ScopedCollection<JournalEntryDoc>) => Promise<T>): Promise<T> {
    return runInOrg(orgId, () => fn(this.store.collection(journalEntries)));
  }

  /** Entries as the API shows them: lines with their accounts, and the reversal if any. */
  private async withDetails(orgId: string, rows: JournalEntryDoc[]): Promise<EntryWithLines[]> {
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((e) => e.lines.map((l) => l.accountId)))];
    const accs = new Map((await runInOrg(orgId, () => this.store.collection(accountsColl).find({ id: { $in: ids } }))).map((a) => [a.id, a]));
    const reversals = new Map(
      (await this.entries(orgId, (c) => c.find({ reversesEntryId: { $in: rows.map((e) => e.id) } }))).map((r) => [r.reversesEntryId!, { id: r.id, entryNumber: r.entryNumber }]),
    );
    return rows.map((e) => ({
      ...e,
      lines: [...e.lines].sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ ...l, account: { code: accs.get(l.accountId)?.code ?? '', name: accs.get(l.accountId)?.name ?? '' } })),
      reversedBy: reversals.get(e.id) ?? null,
    }));
  }

  private async detailed(orgId: string, id: string): Promise<EntryWithLines> {
    const e = await this.entries(orgId, (c) => c.findOne({ id }));
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    return (await this.withDetails(orgId, [e]))[0]!;
  }

  /** Adds an entry in MongoDB and copies it into the caller's PostgreSQL transaction. */
  private async insertEntry(tx: Tx, doc: Omit<JournalEntryDoc, 'id' | 'createdAt' | 'updatedAt'>): Promise<JournalEntryDoc> {
    const now = new Date();
    const created = (await this.entries(doc.orgId, (c) => c.insertOne({ ...doc, createdAt: now, updatedAt: now }))) as JournalEntryDoc;
    await this.mirror.journalEntries([created.id], tx);
    return created;
  }

  // ---------- reads ----------

  async list(orgId: string, q: { status?: 'DRAFT' | 'POSTED'; from?: string; to?: string; accountId?: string; limit: number; offset: number }) {
    const date = { ...(q.from ? { $gte: toDbDate(q.from) } : {}), ...(q.to ? { $lte: toDbDate(q.to) } : {}) };
    const filter = { ...(q.status ? { status: q.status } : {}), ...(q.from || q.to ? { date } : {}), ...(q.accountId ? { 'lines.accountId': q.accountId } : {}) };
    const total = await this.entries(orgId, (c) => c.count(filter));
    const rows = await this.entries(orgId, (c) => c.find(filter, { sort: { date: -1, entryNumber: -1, createdAt: -1 }, limit: q.limit, skip: q.offset }));
    return { total, items: (await this.withDetails(orgId, rows)).map(serialize) };
  }

  async get(orgId: string, id: string) {
    return serialize(await this.detailed(orgId, id));
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
      const created = await this.prisma.$transaction((tx) => this.createInTx(tx, org, actor, input, { post: opts.post, idempotencyKey: opts.idempotencyKey, idempotencyHash: hash }));
      return { replayed: false, entry: serialize(await this.detailed(org.id, created.id)) };
    } catch (e) {
      // Concurrent duplicate with the same idempotency key: the other request won the race.
      if (opts.idempotencyKey && (isDuplicateKeyError(e) || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'))) {
        const replay = await this.findIdempotent(org.id, opts.idempotencyKey, hash!);
        if (replay) return { replayed: true, entry: replay };
      }
      throw e;
    }
  }

  /**
   * Create (and optionally post) a manual journal inside the caller's transaction: the period must
   * be open to post (not closed to save a draft), foreign lines take the recorded rate, and the
   * lines pass the usual checks. Used by journal templates and their schedules too.
   */
  async createInTx(
    tx: Tx,
    org: OrgInfo,
    actor: Actor,
    input: JournalInput,
    opts: { post: boolean; idempotencyKey?: string; idempotencyHash?: string; auditData?: Record<string, unknown> },
  ): Promise<{ id: string; entryNumber: number | null }> {
    const period = await this.lockPeriodForDate(tx, org.id, input.date);
    if (period.status === 'CLOSED' || (opts.post && period.status !== 'OPEN')) {
      throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
    }
    input = { ...input, lines: await this.fillRates(tx, org, input.date, input.lines) };
    const normalized = await this.validate(tx, org, input.lines, { manual: true });
    const posted = opts.post ? await this.posting(tx, org.id, actor.id) : null;
    const created = await this.insertEntry(tx, {
      orgId: org.id,
      date: toDbDate(input.date),
      periodId: period.id,
      type: input.type,
      source: 'MANUAL',
      status: posted ? 'POSTED' : 'DRAFT',
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      functionalCurrency: org.functionalCurrency,
      totalDebit: normalized.totalFunctionalDebit.toFixed(),
      totalCredit: normalized.totalFunctionalCredit.toFixed(),
      idempotencyKey: opts.idempotencyKey ?? null,
      idempotencyHash: opts.idempotencyHash ?? null,
      reversesEntryId: null,
      createdById: actor.id,
      ...(posted ?? { entryNumber: null, postedAt: null, postedById: null }),
      lines: lineRows(normalized),
    });
    const entryNumber = posted?.entryNumber ?? null;
    await this.audit.append(tx, {
      orgId: org.id,
      actorId: actor.id,
      action: opts.post ? 'journal.created_and_posted' : 'journal.draft_created',
      entityType: 'journal_entry',
      entityId: created.id,
      data: { date: input.date, type: input.type, totalDebit: normalized.totalFunctionalDebit.toFixed(), lines: input.lines.length, ...opts.auditData },
    });
    return { id: created.id, entryNumber };
  }

  async updateDraft(org: OrgInfo, actor: Actor, id: string, input: JournalInput) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockEntry(tx, org.id, id);
      if (existing.status !== 'DRAFT') throw new DomainError('ENTRY_POSTED', 'Posted entries are immutable; reverse them instead', HttpStatus.CONFLICT);
      assertManual(existing);
      const period = await this.lockPeriodForDate(tx, org.id, input.date);
      if (period.status === 'CLOSED') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is CLOSED`, HttpStatus.CONFLICT);
      input = { ...input, lines: await this.fillRates(tx, org, input.date, input.lines) };
      const normalized = await this.validate(tx, org, input.lines, { manual: true });
      await this.entries(org.id, (c) =>
        c.updateOne(
          { id, status: 'DRAFT' },
          {
            $set: {
              date: toDbDate(input.date),
              periodId: period.id,
              type: input.type,
              memo: input.memo ?? null,
              reference: input.reference ?? null,
              totalDebit: normalized.totalFunctionalDebit.toFixed(),
              totalCredit: normalized.totalFunctionalCredit.toFixed(),
              lines: lineRows(normalized),
              updatedAt: new Date(),
            },
          },
        ),
      );
      await this.mirror.journalEntries([id], tx);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal.draft_updated', entityType: 'journal_entry', entityId: id, data: { date: input.date, lines: input.lines.length } });
      return id;
    }).then(async (entryId) => serialize(await this.detailed(org.id, entryId)));
  }

  async deleteDraft(orgId: string, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.lockEntry(tx, orgId, id);
      if (existing.status !== 'DRAFT') throw new DomainError('ENTRY_POSTED', 'Posted entries cannot be deleted; reverse them instead', HttpStatus.CONFLICT);
      await this.entries(orgId, (c) => c.deleteOne({ id, status: 'DRAFT' }));
      await this.mirror.removeJournalEntry(id, orgId, tx);
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
      const lines = [...existing.lines].sort((a, b) => a.lineNo - b.lineNo);
      await this.validate(
        tx,
        org,
        lines.map((l) => ({ accountId: l.accountId, currency: l.currency, exchangeRate: l.exchangeRate, debit: l.debit, credit: l.credit })),
        { manual: true },
      );
      const posted = await this.posting(tx, org.id, actor.id);
      await this.entries(org.id, (c) => c.updateOne({ id, status: 'DRAFT' }, { $set: { status: 'POSTED', ...posted, updatedAt: new Date() } }));
      await this.mirror.journalEntries([id], tx);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal.posted', entityType: 'journal_entry', entityId: id, data: { entryNumber: posted.entryNumber } });
      return id;
    }).then(async (entryId) => serialize(await this.detailed(org.id, entryId)));
  }

  /** Post a reversing entry that exactly offsets a posted entry. The original is never modified. */
  async reverse(org: OrgInfo, actor: Actor, id: string, input: { date: string; memo?: string }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const original = await this.lockEntry(tx, org.id, id);
        // Month-end adjustments are journals a person approved with nothing else attached: reversed like manual ones.
        if (original.source !== 'CLOSE') assertManual(original);
        if (original.status !== 'POSTED') throw new DomainError('NOT_POSTED', 'Only posted entries can be reversed; delete the draft instead', HttpStatus.CONFLICT);
        if (original.type === 'REVERSING' || original.reversesEntryId) throw new DomainError('IS_REVERSAL', 'A reversing entry cannot itself be reversed; post a new entry instead', HttpStatus.CONFLICT);
        const already = await this.entries(org.id, (c) => c.findOne({ reversesEntryId: id }));
        if (already) throw new DomainError('ALREADY_REVERSED', 'Entry has already been reversed', HttpStatus.CONFLICT, { reversalId: already.id });
        if (input.date < fromDbDate(original.date)) throw new DomainError('INVALID_DATE', 'Reversal date cannot be before the original entry date');
        await this.assertNotBankMatched(tx, id);
        const period = await this.lockPeriodForDate(tx, org.id, input.date);
        if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);

        const lines = buildReversalLines(
          [...original.lines]
            .sort((a, b) => a.lineNo - b.lineNo)
            .map((l) => ({
              accountId: l.accountId,
              currency: l.currency,
              exchangeRate: l.exchangeRate,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              dimensions: l.dimensions ?? null,
              departmentId: l.departmentId,
              projectId: l.projectId,
            })),
        );
        const normalized = await this.validate(tx, org, lines, { allowInactive: true });
        const posted = await this.posting(tx, org.id, actor.id);
        const created = await this.insertEntry(tx, {
          orgId: org.id,
          date: toDbDate(input.date),
          periodId: period.id,
          // A reversed closing entry stays a closing entry: neither ever counts in profit and loss.
          type: original.type === 'CLOSING' ? 'CLOSING' : 'REVERSING',
          source: 'MANUAL',
          status: 'POSTED',
          memo: input.memo ?? `Reversal of JE-${original.entryNumber}`,
          reference: original.reference,
          functionalCurrency: org.functionalCurrency,
          totalDebit: normalized.totalFunctionalDebit.toFixed(),
          totalCredit: normalized.totalFunctionalCredit.toFixed(),
          idempotencyKey: null,
          idempotencyHash: null,
          reversesEntryId: id,
          createdById: actor.id,
          ...posted,
          lines: lineRows(normalized),
        });
        const entryNumber = posted.entryNumber;
        await this.audit.append(tx, {
          orgId: org.id,
          actorId: actor.id,
          action: 'journal.reversed',
          entityType: 'journal_entry',
          entityId: id,
          data: { reversalId: created.id, reversalNumber: entryNumber, date: input.date },
        });
        return created.id;
      }).then(async (entryId) => serialize(await this.detailed(org.id, entryId)));
    } catch (e) {
      if (isDuplicateKeyError(e) || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) {
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
    input: { date: string; memo?: string; reference?: string; source: 'DOCUMENT' | 'PAYMENT' | 'BANK' | 'EXPENSE' | 'TAX' | 'PAYROLL' | 'CLOSE' | 'ASSET' | 'DEFERRAL' | 'ACCRUAL' | 'LOAN' | 'INTERCOMPANY' | 'FX_REVALUATION' | 'FX_SETTLEMENT' | 'BAD_DEBT' | 'YEAR_END'; type?: 'CLOSING'; lines: JournalLineInput[] },
  ): Promise<{ id: string; entryNumber: number }> {
    const period = await this.lockPeriodForDate(tx, org.id, input.date);
    if (period.status !== 'OPEN') throw new DomainError('PERIOD_NOT_OPEN', `Period ${period.name} is ${period.status}`, HttpStatus.CONFLICT);
    const normalized = await this.validate(tx, org, input.lines);
    const posted = await this.posting(tx, org.id, actor.id);
    const created = await this.insertEntry(tx, {
      orgId: org.id,
      date: toDbDate(input.date),
      periodId: period.id,
      type: input.type ?? 'STANDARD',
      source: input.source,
      status: 'POSTED',
      memo: input.memo ?? null,
      reference: input.reference ?? null,
      functionalCurrency: org.functionalCurrency,
      totalDebit: normalized.totalFunctionalDebit.toFixed(),
      totalCredit: normalized.totalFunctionalCredit.toFixed(),
      idempotencyKey: null,
      idempotencyHash: null,
      reversesEntryId: null,
      createdById: actor.id,
      ...posted,
      lines: lineRows(normalized),
    });
    const entryNumber = posted.entryNumber;
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
    const lines = buildReversalLines(
      [...original.lines]
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((l) => ({
          accountId: l.accountId,
          currency: l.currency,
          exchangeRate: l.exchangeRate,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          departmentId: l.departmentId,
          projectId: l.projectId,
        })),
    );
    const normalized = await this.validate(tx, org, lines, { allowInactive: true });
    const posted = await this.posting(tx, org.id, actor.id);
    const created = await this.insertEntry(tx, {
      orgId: org.id,
      date: toDbDate(input.date),
      periodId: period.id,
      type: original.type === 'CLOSING' ? 'CLOSING' : 'REVERSING',
      source: original.source,
      status: 'POSTED',
      memo: input.memo,
      reference: original.reference,
      functionalCurrency: org.functionalCurrency,
      totalDebit: normalized.totalFunctionalDebit.toFixed(),
      totalCredit: normalized.totalFunctionalCredit.toFixed(),
      idempotencyKey: null,
      idempotencyHash: null,
      reversesEntryId: entryId,
      createdById: actor.id,
      ...posted,
      lines: lineRows(normalized),
    });
    const entryNumber = posted.entryNumber;
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
    const e = await this.entries(orgId, (c) => c.findOne({ idempotencyKey: key }));
    if (!e) return null;
    if (e.idempotencyHash !== hash) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    return serialize((await this.withDetails(orgId, [e]))[0]!);
  }

  /** An entry matched to a bank statement line must be unmatched before it is reversed or voided. */
  private async assertNotBankMatched(tx: Tx, entryId: string) {
    const matched = await tx.bankMatch.count({ where: { removedAt: null, journalLine: { entryId } } });
    if (matched > 0) {
      throw new DomainError('BANK_MATCHED', 'This entry is matched to a bank statement line; unmatch it on the bank reconciliation screen first', HttpStatus.CONFLICT);
    }
  }

  /** Holds the entry's PostgreSQL copy FOR UPDATE (one change at a time), then reads the entry from MongoDB. */
  private async lockEntry(tx: Tx, orgId: string, id: string): Promise<JournalEntryDoc> {
    const rows = await lockRow<{ id: string }>(tx, 'journal_entries', id, orgId);
    const e = rows[0] ? await this.entries(orgId, (c) => c.findOne({ id })) : null;
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    return e;
  }

  /** Find the period containing a date and hold it FOR SHARE so it cannot be locked mid-posting. */
  private async lockPeriodForDate(tx: Tx, orgId: string, date: string) {
    if (postgresOff()) {
      // MongoDB has no shared lock, so the period is read as it stands (TODO step 10c: make a period lock wait for postings).
      const p = await tx.fiscalPeriod.findFirst({ where: { orgId, startDate: { lte: toDbDate(date) }, endDate: { gte: toDbDate(date) } }, select: { id: true, name: true, status: true } });
      if (!p) throw new DomainError('NO_FISCAL_PERIOD', `No fiscal period covers ${date}. Create the fiscal year first.`);
      return { ...p, status: String(p.status) };
    }
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
    const normalized = validateJournal(lines, { functionalCurrency: org.functionalCurrency, accounts: map });
    await checkLineDimensions(tx, org.id, lines, { allowInactive: opts.allowInactive });
    return normalized;
  }

  /**
   * Foreign-currency lines without a rate take the organisation's recorded rate for that currency
   * on or before the entry date (Settings > Exchange rates). Lines with a rate keep it.
   */
  private async fillRates(tx: Tx, org: OrgInfo, date: string, lines: JournalLineInput[]): Promise<JournalLineInput[]> {
    const wanted = [...new Set(lines.filter((l) => l.currency && l.currency !== org.functionalCurrency && l.exchangeRate === undefined).map((l) => l.currency!))];
    if (!wanted.length) return lines;
    const found = new Map<string, string>();
    for (const currency of wanted) {
      const r = await tx.exchangeRate.findFirst({ where: { orgId: org.id, currency, date: { lte: toDbDate(date) } }, orderBy: { date: 'desc' } });
      if (r) found.set(currency, r.rate.toFixed());
    }
    return lines.map((l) => (l.currency && l.exchangeRate === undefined && found.has(l.currency) ? { ...l, exchangeRate: found.get(l.currency)! } : l));
  }

  /**
   * The next entry number and the posting stamp. Numbers are gap-free and in posting order
   * (db/counters.ts).
   */
  private async posting(tx: Tx, orgId: string, actorId: string) {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, 'journal_entry') }];
    return { entryNumber: value, postedAt: new Date(), postedById: actorId };
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
function lineRows(j: NormalizedJournal): JournalEntryDoc['lines'] {
  return j.lines.map((l) => ({
    id: randomUUID(),
    lineNo: l.lineNo,
    accountId: l.accountId,
    currency: l.currency,
    exchangeRate: l.exchangeRate.toFixed(),
    debit: l.debit.toFixed(),
    credit: l.credit.toFixed(),
    functionalDebit: l.functionalDebit.toFixed(),
    functionalCredit: l.functionalCredit.toFixed(),
    description: l.description ?? null,
    dimensions: l.dimensions ?? null,
    departmentId: l.departmentId ?? null,
    projectId: l.projectId ?? null,
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
    totalDebit: new Prisma.Decimal(e.totalDebit).toFixed(fScale),
    totalCredit: new Prisma.Decimal(e.totalCredit).toFixed(fScale),
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
      exchangeRate: new Prisma.Decimal(l.exchangeRate).toFixed(),
      debit: new Prisma.Decimal(l.debit).toFixed(minorUnits(l.currency)),
      credit: new Prisma.Decimal(l.credit).toFixed(minorUnits(l.currency)),
      functionalDebit: new Prisma.Decimal(l.functionalDebit).toFixed(fScale),
      functionalCredit: new Prisma.Decimal(l.functionalCredit).toFixed(fScale),
      description: l.description,
      dimensions: l.dimensions,
      departmentId: l.departmentId,
      projectId: l.projectId,
    })),
  };
}
