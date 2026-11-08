import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  dec,
  disputeAge,
  disputeIssues,
  disputeRef,
  disputeSummary,
  minorUnits,
  resolutionIssues,
  toFunctional,
  type DisputeOutcome,
  type DisputeReason,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
export interface DisputeOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
export interface DisputeInput {
  amount?: string | null;
  reason: DisputeReason;
  description: string;
  ownerId?: string | null;
  targetDate?: string | null;
}

/** SQL: no open dispute on invoice `d` (used by reminders and overdue-invoice workflows). */
export const NOT_DISPUTED = Prisma.sql`NOT EXISTS (SELECT 1 FROM invoice_disputes s WHERE s.document_id = d.id AND s.status = 'OPEN')`;

/**
 * Customer invoice disputes (AR-025): raised on a posted invoice with an amount still due, worked
 * with notes, an owner and a target date, and resolved with a credit note, the customer paying, a
 * write-off or the customer withdrawing it. An open dispute keeps the invoice out of payment
 * reminders and the overdue-invoice workflow trigger. The history is append-only.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(org: DisputeOrg, q: { status?: 'open' | 'resolved' | 'all'; documentId?: string; contactId?: string } = {}) {
    const today = todayIst();
    const all = await this.prisma.invoiceDispute.findMany({
      where: { orgId: org.id, ...(q.documentId ? { documentId: q.documentId } : {}), ...(q.contactId ? { contactId: q.contactId } : {}) },
      orderBy: [{ number: 'desc' }],
      take: 1000,
    });
    const view = q.status ?? 'open';
    const shown = all.filter((d) => view === 'all' || d.status === (view === 'open' ? 'OPEN' : 'RESOLVED'));
    const ctx = await this.context(org, all);
    const rows = shown.map((d) => this.row(org, d, ctx, today));
    return {
      today,
      currency: org.functionalCurrency,
      summary: disputeSummary(
        all.map((d) => ({
          status: d.status as 'OPEN' | 'RESOLVED',
          amount: this.functional(org, d, ctx).toFixed(),
          openedOn: fromDbDate(d.openedOn),
          resolvedOn: d.resolvedOn ? fromDbDate(d.resolvedOn) : null,
          targetDate: d.targetDate ? fromDbDate(d.targetDate) : null,
          outcome: d.outcome as DisputeOutcome | null,
        })),
        today,
        org.functionalCurrency,
      ),
      disputes: rows,
      members: await this.members(org.id),
      can: { manage: hasPermission(org.role, 'sales.manage') },
    };
  }

  async get(org: DisputeOrg, id: string) {
    const today = todayIst();
    const d = await this.prisma.invoiceDispute.findFirst({ where: { id, orgId: org.id } });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Dispute not found' });
    const ctx = await this.context(org, [d]);
    const events = await this.prisma.invoiceDisputeEvent.findMany({ where: { disputeId: d.id, orgId: org.id }, orderBy: { createdAt: 'asc' } });
    const names = await this.names(events.map((e) => e.actorId));
    const creditNotes =
      d.status === 'OPEN'
        ? await this.prisma.document.findMany({
            where: { orgId: org.id, kind: 'CREDIT_NOTE', status: 'POSTED', contactId: d.contactId, currency: ctx.docs.get(d.documentId)!.currency, issueDate: { gte: ctx.docs.get(d.documentId)!.issueDate } },
            orderBy: { issueDate: 'desc' },
            take: 50,
            select: { id: true, number: true, issueDate: true, total: true, currency: true },
          })
        : [];
    return {
      ...this.row(org, d, ctx, today),
      events: events.map((e) => ({ id: e.id, kind: e.kind, body: e.body, data: e.data, by: names.get(e.actorId) ?? 'A member', at: e.createdAt.toISOString() })),
      creditNotes: creditNotes.map((c) => ({ id: c.id, number: c.number, issueDate: fromDbDate(c.issueDate), total: c.total.toFixed(minorUnits(c.currency)), currency: c.currency })),
      members: await this.members(org.id),
      can: { manage: hasPermission(org.role, 'sales.manage') && d.status === 'OPEN' },
    };
  }

  async raise(org: DisputeOrg, actor: Actor, input: DisputeInput & { documentId: string }) {
    const today = todayIst();
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM documents WHERE id = ${input.documentId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: input.documentId, orgId: org.id } });
      if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
      if (doc.status !== 'POSTED') throw new DomainError('NOT_DISPUTABLE', 'Only a posted invoice can be disputed', HttpStatus.CONFLICT);
      const open = await this.openOn(tx, doc.id, doc.total);
      if (open.lte(0)) throw new DomainError('NOT_DISPUTABLE', 'This invoice has nothing left to pay', HttpStatus.CONFLICT);
      const already = await tx.invoiceDispute.findFirst({ where: { orgId: org.id, documentId: doc.id, status: 'OPEN' }, select: { number: true } });
      if (already) throw new DomainError('DISPUTE_OPEN', `${disputeRef(already.number)} is already open on this invoice`, HttpStatus.CONFLICT);
      const scale = minorUnits(doc.currency);
      const amount = input.amount ? dec(input.amount).toFixed() : open.toFixed(scale);
      this.check({ ...input, amount }, open.toFixed(scale), doc.currency, today);
      await this.assertMember(tx, org.id, input.ownerId);
      const [{ value: number }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'invoice_dispute', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1 RETURNING value`;
      const d = await tx.invoiceDispute.create({
        data: {
          orgId: org.id,
          number,
          documentId: doc.id,
          contactId: doc.contactId,
          amount,
          reason: input.reason,
          description: input.description.trim(),
          ownerId: input.ownerId ?? null,
          targetDate: input.targetDate ? toDbDate(input.targetDate) : null,
          openedOn: toDbDate(today),
          openedById: actor.id,
        },
      });
      await tx.invoiceDisputeEvent.create({ data: { orgId: org.id, disputeId: d.id, kind: 'RAISED', body: input.description.trim(), data: { amount, reason: input.reason }, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_dispute.raised', entityType: 'document', entityId: doc.id, data: { dispute: disputeRef(number), number: doc.number, amount, reason: input.reason } });
      return d.id;
    });
    return this.get(org, id);
  }

  async update(org: DisputeOrg, actor: Actor, id: string, input: DisputeInput) {
    const today = todayIst();
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, org, id);
      const doc = await tx.document.findFirstOrThrow({ where: { id: d.documentId, orgId: org.id } });
      const scale = minorUnits(doc.currency);
      const amount = input.amount ? dec(input.amount).toFixed() : d.amount.toFixed();
      this.check({ ...input, amount }, (await this.openOn(tx, doc.id, doc.total)).toFixed(scale), doc.currency, d.targetDate && input.targetDate === fromDbDate(d.targetDate) ? '0000-01-01' : today);
      await this.assertMember(tx, org.id, input.ownerId);
      const before = { amount: d.amount.toFixed(scale), reason: d.reason, description: d.description, ownerId: d.ownerId, targetDate: d.targetDate ? fromDbDate(d.targetDate) : null };
      const after = { amount: dec(amount).toFixed(scale), reason: input.reason, description: input.description.trim(), ownerId: input.ownerId ?? null, targetDate: input.targetDate ?? null };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]);
      if (!changed.length) return;
      await tx.invoiceDispute.update({ where: { id: d.id }, data: { amount, reason: input.reason, description: after.description, ownerId: after.ownerId, targetDate: after.targetDate ? toDbDate(after.targetDate) : null } });
      const ownerNames = await this.names([before.ownerId, after.ownerId].filter((x): x is string => !!x));
      const show = (k: keyof typeof after, v: string | null) => (v == null ? null : k === 'ownerId' ? (ownerNames.get(v) ?? v) : v);
      const diff = Object.fromEntries(changed.map((k) => [k === 'ownerId' ? 'owner' : k, { from: show(k, before[k]), to: show(k, after[k]) }]));
      await tx.invoiceDisputeEvent.create({ data: { orgId: org.id, disputeId: d.id, kind: 'CHANGED', data: diff, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_dispute.changed', entityType: 'document', entityId: d.documentId, data: { dispute: disputeRef(d.number), ...diff } });
    });
    return this.get(org, id);
  }

  async note(org: DisputeOrg, actor: Actor, id: string, body: string) {
    if (!body.trim()) throw new DomainError('DISPUTE_INVALID', 'Write the note first');
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, org, id);
      await tx.invoiceDisputeEvent.create({ data: { orgId: org.id, disputeId: d.id, kind: 'NOTE', body: body.trim(), actorId: actor.id } });
    });
    return this.get(org, id);
  }

  async resolve(org: DisputeOrg, actor: Actor, id: string, input: { outcome: DisputeOutcome; creditNoteId?: string | null; note: string }) {
    const today = todayIst();
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockOpen(tx, org, id);
      const inv = await tx.document.findFirstOrThrow({ where: { id: d.documentId, orgId: org.id }, select: { currency: true, number: true } });
      const cn = input.creditNoteId ? await tx.document.findFirst({ where: { id: input.creditNoteId, orgId: org.id, kind: 'CREDIT_NOTE' }, select: { id: true, status: true, contactId: true, currency: true, number: true } }) : null;
      if (input.creditNoteId && !cn) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Credit note not found' });
      const issues = resolutionIssues({ outcome: input.outcome, note: input.note, creditNote: cn ? { status: cn.status, contactMatches: cn.contactId === d.contactId, currencyMatches: cn.currency === inv.currency } : input.creditNoteId ? undefined : null });
      if (issues.length) throw new DomainError('RESOLUTION_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
      await tx.invoiceDispute.update({ where: { id: d.id }, data: { status: 'RESOLVED', outcome: input.outcome, creditNoteId: cn?.id ?? null, resolutionNote: input.note.trim(), resolvedOn: toDbDate(today), resolvedById: actor.id } });
      await tx.invoiceDisputeEvent.create({ data: { orgId: org.id, disputeId: d.id, kind: 'RESOLVED', body: input.note.trim(), data: { outcome: input.outcome, creditNote: cn?.number ?? null }, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'invoice_dispute.resolved', entityType: 'document', entityId: d.documentId, data: { dispute: disputeRef(d.number), number: inv.number, outcome: input.outcome, creditNote: cn?.number ?? null } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ helpers

  private check(input: DisputeInput & { amount: string }, open: string, currency: string, today: string) {
    const issues = disputeIssues({ amount: input.amount, open, currency, description: input.description, targetDate: input.targetDate, today });
    if (issues.length) throw new DomainError('DISPUTE_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  private async lockOpen(tx: Tx, org: DisputeOrg, id: string) {
    await tx.$queryRaw`SELECT id FROM invoice_disputes WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
    const d = await tx.invoiceDispute.findFirst({ where: { id, orgId: org.id } });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Dispute not found' });
    if (d.status !== 'OPEN') throw new DomainError('DISPUTE_RESOLVED', `${disputeRef(d.number)} is resolved; raise a new dispute if the customer queries the invoice again`, HttpStatus.CONFLICT);
    return d;
  }

  private async openOn(tx: Tx, documentId: string, total: Prisma.Decimal) {
    const used = await tx.allocation.aggregate({ where: { targetId: documentId, removedOn: null }, _sum: { amount: true } });
    return new D(total.toFixed()).minus((used._sum.amount ?? 0).toString());
  }

  private async assertMember(tx: Tx, orgId: string, userId?: string | null) {
    if (!userId) return;
    const m = await tx.membership.findFirst({ where: { orgId, userId }, select: { id: true } });
    if (!m) throw new DomainError('DISPUTE_INVALID', 'The owner must be a member of this organisation');
  }

  private async context(org: DisputeOrg, rows: { documentId: string; contactId: string; creditNoteId: string | null; ownerId: string | null; openedById: string; resolvedById: string | null }[]) {
    const docIds = [...new Set(rows.flatMap((r) => [r.documentId, ...(r.creditNoteId ? [r.creditNoteId] : [])]))];
    const docs = docIds.length
      ? await this.prisma.document.findMany({ where: { orgId: org.id, id: { in: docIds } }, select: { id: true, number: true, issueDate: true, dueDate: true, total: true, currency: true, exchangeRate: true } })
      : [];
    const contacts = rows.length ? await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.contactId))] } }, select: { id: true, name: true } }) : [];
    const users = await this.names(rows.flatMap((r) => [r.ownerId, r.openedById, r.resolvedById]).filter((x): x is string => !!x));
    const due = docIds.length
      ? await this.prisma.allocation.groupBy({ by: ['targetId'], where: { orgId: org.id, targetId: { in: docIds }, removedOn: null }, _sum: { amount: true } })
      : [];
    return {
      docs: new Map(docs.map((d) => [d.id, d])),
      contacts: new Map(contacts.map((c) => [c.id, c.name])),
      users,
      paid: new Map(due.map((a) => [a.targetId, new D((a._sum.amount ?? 0).toString())])),
    };
  }

  private functional(org: DisputeOrg, d: { amount: Prisma.Decimal; documentId: string }, ctx: Awaited<ReturnType<DisputesService['context']>>) {
    const doc = ctx.docs.get(d.documentId);
    if (!doc || doc.currency === org.functionalCurrency) return dec(d.amount.toFixed());
    return toFunctional(dec(d.amount.toFixed()), doc.exchangeRate.toFixed(), org.functionalCurrency);
  }

  private row(org: DisputeOrg, d: Prisma.InvoiceDisputeGetPayload<object>, ctx: Awaited<ReturnType<DisputesService['context']>>, today: string) {
    const doc = ctx.docs.get(d.documentId)!;
    const scale = minorUnits(doc.currency);
    const cn = d.creditNoteId ? ctx.docs.get(d.creditNoteId) : null;
    const openedOn = fromDbDate(d.openedOn);
    const resolvedOn = d.resolvedOn ? fromDbDate(d.resolvedOn) : null;
    const targetDate = d.targetDate ? fromDbDate(d.targetDate) : null;
    return {
      id: d.id,
      ref: disputeRef(d.number),
      status: d.status as 'OPEN' | 'RESOLVED',
      invoice: { id: doc.id, number: doc.number, issueDate: fromDbDate(doc.issueDate), dueDate: doc.dueDate ? fromDbDate(doc.dueDate) : null, total: doc.total.toFixed(scale), due: new D(doc.total.toFixed()).minus(ctx.paid.get(doc.id) ?? 0).toFixed(scale), currency: doc.currency },
      customer: { id: d.contactId, name: ctx.contacts.get(d.contactId) ?? '' },
      amount: d.amount.toFixed(scale),
      functionalAmount: this.functional(org, d, ctx).toFixed(minorUnits(org.functionalCurrency)),
      reason: d.reason as DisputeReason,
      description: d.description,
      owner: d.ownerId ? { id: d.ownerId, name: ctx.users.get(d.ownerId) ?? 'A member' } : null,
      targetDate,
      pastTarget: d.status === 'OPEN' && targetDate != null && targetDate < today,
      openedOn,
      openedBy: ctx.users.get(d.openedById) ?? 'A member',
      days: disputeAge(openedOn, resolvedOn, today),
      outcome: d.outcome as DisputeOutcome | null,
      creditNote: cn ? { id: cn.id, number: cn.number } : null,
      resolutionNote: d.resolutionNote,
      resolvedOn,
      resolvedBy: d.resolvedById ? (ctx.users.get(d.resolvedById) ?? 'A member') : null,
    };
  }

  private async members(orgId: string) {
    const ms = await this.prisma.membership.findMany({ where: { orgId }, include: { user: { select: { id: true, name: true, email: true } } } });
    return ms.map((m) => ({ id: m.user.id, name: m.user.name || m.user.email })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async names(ids: string[]) {
    const list = [...new Set(ids)];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name || u.email]));
  }
}
