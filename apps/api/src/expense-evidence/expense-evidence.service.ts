import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, collectExpenseEvidence, EXPENSE_EVIDENCE_KINDS, expenseEvidenceCsv, minorUnits, type EvidenceClaim } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { bankMatches, bankStatementLines } from '../db/collections/banking';
import { journalEntries } from '../db/collections/ledger';

const MAX_CLAIMS = 1000;

/**
 * Automated audit evidence for expense claims (EXP-027): for each claim decided in a period, the
 * receipts (with SHA-256), approval, policy exceptions and their note, journal entries, the
 * reimbursement and its bank statement match, and the hash-chained audit events, collected from
 * the records, with what is missing. Read-only; an index can be downloaded as CSV.
 */
@Injectable()
export class ExpenseEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
  ) {}

  private period(q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso();
    const from = q.from ?? addDays(to, -89);
    if (from > to) throw new DomainError('PERIOD_INVALID', 'The period starts after it ends', HttpStatus.UNPROCESSABLE_ENTITY);
    return { from, to };
  }

  private async collect(org: OrgContext, where: { from: string; to: string } | { id: string }) {
    const claims = await this.prisma.expenseClaim.findMany({
      where: { orgId: org.id, status: { in: ['APPROVED', 'REIMBURSED', 'VOID'] }, ...('id' in where ? { id: where.id } : { postingDate: { gte: toDbDate(where.from), lte: toDbDate(where.to) } }) },
      orderBy: [{ postingDate: 'asc' }, { number: 'asc' }],
      take: MAX_CLAIMS + 1,
    });
    if (claims.length > MAX_CLAIMS) throw new DomainError('TOO_MANY_CLAIMS', `More than ${MAX_CLAIMS} claims in the period: choose a shorter one`, HttpStatus.UNPROCESSABLE_ENTITY);
    const ids = claims.map((c) => c.id);
    if (!ids.length) return [];
    const entryIds = claims.flatMap((c) => [c.journalEntryId, c.reimbursementJournalEntryId]).filter((x): x is string => !!x);
    const bankIds = [...new Set(claims.map((c) => c.bankAccountId).filter((x): x is string => !!x))];
    const [users, files, entries, events, banks] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: [...new Set(claims.flatMap((c) => [c.claimantId, c.decidedById]).filter((x): x is string => !!x))] } }, select: { id: true, name: true, email: true } }),
      this.prisma.attachment.findMany({ where: { orgId: org.id, entityType: 'EXPENSE_CLAIM', entityId: { in: ids }, removedAt: null }, select: { id: true, entityId: true, fileName: true, sha256: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
      entryIds.length ? this.store.collection(journalEntries).find({ id: { $in: entryIds } }) : [],
      this.prisma.auditEvent.findMany({ where: { orgId: org.id, entityType: 'expense_claim', entityId: { in: ids } }, orderBy: { id: 'asc' }, select: { action: true, entityId: true, data: true, hash: true, createdAt: true, actorId: true } }),
      bankIds.length ? this.prisma.account.findMany({ where: { orgId: org.id, id: { in: bankIds } }, select: { id: true, code: true, name: true, subtype: true } }) : [],
    ]);
    const entry = new Map(entries.map((e) => [e.id, e]));
    const lineOf = new Map(claims.filter((c) => c.reimbursementJournalEntryId).map((c) => [c.id, entry.get(c.reimbursementJournalEntryId!)?.lines.find((l) => l.accountId === c.bankAccountId)?.id ?? null]));
    const lineIds = [...lineOf.values()].filter((x): x is string => !!x);
    const [matches, latest] = await Promise.all([
      lineIds.length ? this.store.collection(bankMatches).find({ journalLineId: { $in: lineIds }, removedAt: null }) : [],
      Promise.all(bankIds.map(async (id) => [id, (await this.store.collection(bankStatementLines).find({ accountId: id }, { sort: { date: -1 }, limit: 1 }))[0]?.date ?? null] as const)),
    ]);
    const matched = new Set(matches.map((m) => m.journalLineId));
    const through = new Map(latest.map(([id, d]) => [id, d ? fromDbDate(d) : null]));
    const name = new Map(users.map((u) => [u.id, u.name || u.email]));
    const bank = new Map(banks.map((b) => [b.id, b]));
    const ref = (id: string | null) => {
      const e = id ? entry.get(id) : undefined;
      return e ? { number: e.entryNumber != null ? `JE-${e.entryNumber}` : 'Draft entry', posted: e.status === 'POSTED' } : null;
    };
    return claims.map((c) => {
      const mine = events.filter((e) => e.entityId === c.id);
      const approved = [...mine].reverse().find((e) => e.action === 'expense_claim.approved');
      const exceptions = (approved?.data as { policyExceptions?: string[] } | null)?.policyExceptions ?? [];
      const receipts = files.filter((f) => f.entityId === c.id);
      const b = c.bankAccountId ? bank.get(c.bankAccountId) : undefined;
      const input: EvidenceClaim = {
        status: c.status as EvidenceClaim['status'],
        claimantId: c.claimantId,
        approvedOn: c.postingDate ? fromDbDate(c.postingDate) : null,
        approver: c.decidedById ? { id: c.decidedById, name: name.get(c.decidedById) ?? 'Former member' } : null,
        decidedAt: c.decidedAt?.toISOString() ?? null,
        decisionNote: c.decisionNote,
        policyExceptions: exceptions,
        receipts: receipts.map((f) => ({ fileName: f.fileName, sha256: f.sha256 })),
        journal: ref(c.journalEntryId),
        reimbursement:
          c.status === 'REIMBURSED' && c.reimbursedOn
            ? {
                date: fromDbDate(c.reimbursedOn),
                account: b ? `${b.code} · ${b.name}` : 'Unknown account',
                cash: b?.subtype === 'CASH',
                journal: ref(c.reimbursementJournalEntryId)?.number ?? null,
                onStatement: !!lineOf.get(c.id) && matched.has(lineOf.get(c.id)!),
                statementThrough: c.bankAccountId ? (through.get(c.bankAccountId) ?? null) : null,
              }
            : null,
        voided: c.status === 'VOID' && c.voidDate ? { date: fromDbDate(c.voidDate), reason: c.voidReason ?? '' } : null,
        auditActions: mine.map((e) => e.action),
      };
      const evidence = collectExpenseEvidence(input);
      return {
        id: c.id,
        number: c.number,
        title: c.title,
        claimantId: c.claimantId,
        claimant: name.get(c.claimantId) ?? 'Former member',
        status: c.status,
        total: c.total.toFixed(minorUnits(org.functionalCurrency)),
        approvedOn: input.approvedOn,
        ...evidence,
        files: receipts.map((f) => ({ id: f.id, fileName: f.fileName, sha256: f.sha256, uploadedAt: f.createdAt.toISOString() })),
        events: mine.map((e) => ({ action: e.action, by: e.actorId ? (name.get(e.actorId) ?? null) : null, at: e.createdAt.toISOString(), hash: e.hash })),
      };
    });
  }

  /** Every claim decided in the period with its evidence; by default the 90 days to today. */
  async list(org: OrgContext, q: { from?: string; to?: string; gapsOnly?: boolean }) {
    const p = this.period(q);
    const all = await this.collect(org, p);
    const rows = q.gapsOnly ? all.filter((c) => !c.complete) : all;
    return {
      ...p,
      currency: org.functionalCurrency,
      summary: {
        claims: all.length,
        complete: all.filter((c) => c.complete).length,
        withGaps: all.filter((c) => !c.complete).length,
        gaps: Object.fromEntries(EXPENSE_EVIDENCE_KINDS.map((k) => [k, all.filter((c) => c.gaps.includes(k)).length])),
        files: all.reduce((n, c) => n + c.files.length, 0),
      },
      claims: rows.map(({ events, files, ...c }) => ({ ...c, files: files.length, events: events.length })),
    };
  }

  /** One claim's evidence pack: every item, the files with their checksums, and the audit events. */
  async detail(org: OrgContext, claimId: string) {
    const [c] = await this.collect(org, { id: claimId });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'No decided expense claim with that id' });
    return { currency: org.functionalCurrency, ...c };
  }

  /** The evidence index as CSV: one row per item and per receipt file. */
  async exportCsv(org: OrgContext, q: { from?: string; to?: string }) {
    const p = this.period(q);
    const all = await this.collect(org, p);
    return { fileName: `expense-evidence-${p.from}-to-${p.to}.csv`, csv: expenseEvidenceCsv(all.map((c) => ({ number: c.number, claimant: c.claimant, status: c.status, total: c.total, items: c.items, receipts: c.files }))) };
  }
}
