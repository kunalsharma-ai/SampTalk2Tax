import { Injectable, NotFoundException } from '@nestjs/common';
import { HistoryEventInput, HistoryRelation, TransactionKind, transactionTimeline } from '@talk2tax/accounting-engine';
import { auditHash } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';

const ATTACHMENT_ENTITY: Record<TransactionKind, string> = { document: 'DOCUMENT', payment: 'PAYMENT', journal_entry: 'JOURNAL_ENTRY', expense_claim: 'EXPENSE_CLAIM' };
const EVENT_LIMIT = 2000;

/**
 * Transaction history (AUDIT-005): one document, payment, journal entry or expense claim as the
 * audit trail recorded it, with the allocations, files and journal entries that hang off it. Each
 * event is checked against its own hash, so an altered event shows as such.
 */
@Injectable()
export class TransactionHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  private async root(org: OrgContext, kind: TransactionKind, id: string) {
    const where = { id, orgId: org.id };
    switch (kind) {
      case 'document': {
        const d = await this.prisma.document.findFirst({ where, select: { kind: true, number: true, status: true, journalEntryId: true, voidJournalEntryId: true } });
        return d && { label: `${d.kind.replace(/_/g, ' ').toLowerCase()} ${d.number ?? '(draft)'}`, subtype: d.kind, status: d.status, journals: [d.journalEntryId, d.voidJournalEntryId] };
      }
      case 'payment': {
        const p = await this.prisma.payment.findFirst({ where, select: { kind: true, number: true, status: true, journalEntryId: true, voidJournalEntryId: true } });
        return p && { label: `${p.kind === 'RECEIPT' ? 'receipt' : 'payment'} ${p.number}`, subtype: p.kind, status: p.status, journals: [p.journalEntryId, p.voidJournalEntryId] };
      }
      case 'journal_entry': {
        const j = await this.prisma.journalEntry.findFirst({ where, select: { entryNumber: true, status: true, reversesEntryId: true } });
        if (!j) return null;
        const reversal = await this.prisma.journalEntry.findFirst({ where: { orgId: org.id, reversesEntryId: id }, select: { id: true } });
        return { label: `journal ${j.entryNumber ?? '(draft)'}`, subtype: null, status: j.status, journals: [j.reversesEntryId, reversal?.id ?? null] };
      }
      case 'expense_claim': {
        const c = await this.prisma.expenseClaim.findFirst({ where, select: { number: true, status: true, journalEntryId: true, reimbursementJournalEntryId: true, voidJournalEntryId: true } });
        return c && { label: `expense claim ${c.number}`, subtype: null, status: c.status, journals: [c.journalEntryId, c.reimbursementJournalEntryId, c.voidJournalEntryId] };
      }
    }
  }

  async history(org: OrgContext, kind: TransactionKind, id: string) {
    const root = await this.root(org, kind, id);
    if (!root) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Transaction not found' });
    // What hangs off it: money applied to or from it, its files, the journal entries it posted.
    const allocations =
      kind === 'document' || kind === 'payment'
        ? await this.prisma.allocation.findMany({ where: { orgId: org.id, OR: kind === 'document' ? [{ targetId: id }, { creditDocumentId: id }] : [{ paymentId: id }] }, select: { id: true, fxJournalEntryId: true } })
        : [];
    const files = await this.prisma.attachment.findMany({ where: { orgId: org.id, entityType: ATTACHMENT_ENTITY[kind] as never, entityId: id }, select: { id: true } });
    const journals = [...new Set([...root.journals, ...allocations.map((a) => a.fxJournalEntryId)].filter((x): x is string => !!x && x !== id))];
    const groups: { type: string; ids: string[]; relation: HistoryRelation }[] = [
      { type: kind, ids: [id], relation: 'RECORD' as const },
      { type: 'allocation', ids: allocations.map((a) => a.id), relation: 'ALLOCATION' as const },
      { type: 'attachment', ids: files.map((f) => f.id), relation: 'FILE' as const },
      { type: 'journal_entry', ids: journals, relation: 'JOURNAL' as const },
    ].filter((g) => g.ids.length);
    const rows = await this.prisma.auditEvent.findMany({
      where: { orgId: org.id, OR: groups.map((g) => ({ entityType: g.type, entityId: { in: g.ids } })) },
      orderBy: { id: 'asc' },
      take: EVENT_LIMIT,
    });
    const relationOf = (type: string, entityId: string | null) => groups.find((g) => g.type === type && entityId && g.ids.includes(entityId))?.relation ?? 'RECORD';
    const events: HistoryEventInput[] = rows.map((e) => ({
      id: e.id.toString(),
      at: e.createdAt.toISOString(),
      actorId: e.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      data: e.data,
      relation: relationOf(e.entityType, e.entityId),
      intact: auditHash(e.prevHash, { orgId: e.orgId, actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId, data: e.data, createdAt: e.createdAt.toISOString() }) === e.hash,
    }));
    const t = transactionTimeline(events);
    const actorIds = [...new Set(t.events.map((e) => e.actorId).filter((x): x is string => !!x))];
    const users = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    return {
      kind,
      id,
      label: root.label,
      subtype: root.subtype,
      status: root.status,
      truncated: rows.length >= EVENT_LIMIT,
      summary: t.summary,
      events: t.events.map((e) => ({ id: e.id, at: e.at, actor: e.actorId ? (names.get(e.actorId) ?? 'A former member') : 'Talk2Tax', action: e.action, title: e.title, relation: e.relation, entityType: e.entityType, entityId: e.entityId, facts: e.facts, changes: e.changes, intact: e.intact })),
    };
  }
}
