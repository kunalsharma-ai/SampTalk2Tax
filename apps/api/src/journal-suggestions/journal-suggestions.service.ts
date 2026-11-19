import { HttpStatus, Injectable } from '@nestjs/common';
import { addMonths, suggestJournals, lastDayOf, type JournalSuggestion, type SuggestionJournal } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { journalEntries } from '../db/collections/ledger';
import { JournalsService } from '../journals/journals.service';

type Actor = { id: string };

/**
 * Automated journal suggestions (GL-036): missed repeat journals and accruals for a month, worked
 * out from the books each time they are read (see the engine's `suggestJournals`). Accepting one
 * saves it as a draft journal for someone to check and post; dismissing one keeps it out of that
 * month's list. Either decision is recorded once and audited.
 */
@Injectable()
export class JournalSuggestionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly journals: JournalsService,
  ) {}

  private async compute(org: OrgContext, month: string) {
    const from = `${addMonths(month, -3)}-01`;
    const to = lastDayOf(month);
    const [docs, accounts] = await Promise.all([
      runInOrg(org.id, () => this.store.collection(journalEntries).find({ date: { $gte: toDbDate(from), $lte: toDbDate(to) }, status: { $in: ['POSTED', 'DRAFT'] } }, { sort: { date: 1, entryNumber: 1 } })),
      this.prisma.account.findMany({ where: { orgId: org.id }, select: { id: true, code: true, name: true, type: true, subtype: true, isActive: true, isPostable: true } }),
    ]);
    const journals: SuggestionJournal[] = docs.map((j) => ({
      id: j.id,
      entryNumber: j.entryNumber,
      date: fromDbDate(j.date),
      source: j.source,
      type: j.type,
      status: j.status as 'POSTED' | 'DRAFT',
      isReversal: !!j.reversesEntryId,
      memo: j.memo,
      lines: j.lines.map((l) => ({ accountId: l.accountId, debit: l.functionalDebit, credit: l.functionalCredit, description: l.description, departmentId: l.departmentId, projectId: l.projectId })),
    }));
    const result = suggestJournals({ month, today: todayIso(), currency: org.functionalCurrency, journals, accounts: accounts.map((a) => ({ ...a, type: String(a.type), subtype: a.subtype ? String(a.subtype) : null })) });
    return { result, accounts: new Map(accounts.map((a) => [a.id, a])) };
  }

  async list(org: OrgContext, month: string) {
    const { result, accounts } = await this.compute(org, month);
    const decisions = await this.prisma.journalSuggestionDecision.findMany({ where: { orgId: org.id, month }, orderBy: { createdAt: 'desc' } });
    const decided = new Set(decisions.map((d) => d.key));
    const entries = decisions.filter((d) => d.journalEntryId).length
      ? await this.prisma.journalEntry.findMany({ where: { orgId: org.id, id: { in: decisions.map((d) => d.journalEntryId).filter((x): x is string => !!x) } }, select: { id: true, entryNumber: true, status: true } })
      : [];
    const entry = new Map(entries.map((e) => [e.id, e]));
    const view = (s: JournalSuggestion) => ({
      ...s,
      lines: s.lines.map((l) => {
        const a = accounts.get(l.accountId);
        return { ...l, accountCode: a?.code ?? '', accountName: a?.name ?? '' };
      }),
    });
    return {
      month,
      suggestions: result.suggestions.filter((s) => !decided.has(s.key)).map(view),
      notes: result.notes,
      decisions: decisions.map((d) => ({
        id: d.id,
        key: d.key,
        kind: d.kind,
        action: d.action,
        title: d.title,
        total: d.total.toFixed(),
        reason: d.reason,
        createdAt: d.createdAt.toISOString(),
        journal: d.journalEntryId ? { id: d.journalEntryId, entryNumber: entry.get(d.journalEntryId)?.entryNumber ?? null, status: entry.get(d.journalEntryId)?.status ?? null } : null,
      })),
    };
  }

  private async pick(org: OrgContext, month: string, key: string) {
    const { result } = await this.compute(org, month);
    const s = result.suggestions.find((x) => x.key === key);
    if (!s) throw new DomainError('SUGGESTION_GONE', 'This suggestion no longer applies: the month may already have the entry', HttpStatus.CONFLICT);
    if (await this.prisma.journalSuggestionDecision.findFirst({ where: { orgId: org.id, month, key } })) throw new DomainError('SUGGESTION_DECIDED', 'This suggestion was already accepted or dismissed', HttpStatus.CONFLICT);
    return s;
  }

  /** Saves the suggestion as a draft journal and records that it was accepted. */
  async accept(org: OrgContext, actor: Actor, month: string, key: string) {
    const s = await this.pick(org, month, key);
    const made = await this.prisma.$transaction(async (tx) => {
      const j = await this.journals.createInTx(
        tx,
        org,
        actor,
        {
          date: s.date,
          type: s.type,
          memo: s.memo,
          reference: s.kind === 'ACCRUAL' ? `Accrual ${month}` : undefined,
          lines: s.lines.map((l) => ({ accountId: l.accountId, ...(l.debit ? { debit: l.debit } : {}), ...(l.credit ? { credit: l.credit } : {}), ...(l.description ? { description: l.description } : {}), departmentId: l.departmentId ?? null, projectId: l.projectId ?? null })),
        },
        { post: false, auditData: { suggestion: s.key, month } },
      );
      await tx.journalSuggestionDecision.create({ data: { id: randomUUID(), orgId: org.id, month, key: s.key, kind: s.kind, action: 'ACCEPTED', title: s.title.slice(0, 200), total: s.total, journalEntryId: j.id, reason: null, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_suggestion.accepted', entityType: 'journal_entry', entityId: j.id, data: { month, key: s.key, kind: s.kind, title: s.title, total: s.total, date: s.date } });
      return j;
    });
    return this.journals.get(org.id, made.id);
  }

  async dismiss(org: OrgContext, actor: Actor, month: string, key: string, reason: string) {
    if (reason.trim().length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the suggestion is dismissed', HttpStatus.UNPROCESSABLE_ENTITY);
    const s = await this.pick(org, month, key);
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.journalSuggestionDecision.create({ data: { id, orgId: org.id, month, key: s.key, kind: s.kind, action: 'DISMISSED', title: s.title.slice(0, 200), total: s.total, journalEntryId: null, reason: reason.trim(), createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_suggestion.dismissed', entityType: 'journal_suggestion', entityId: id, data: { month, key: s.key, kind: s.kind, title: s.title, total: s.total, reason: reason.trim() } });
    });
    return this.list(org, month);
  }
}
