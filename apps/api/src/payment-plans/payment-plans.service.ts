import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, D, minorUnits, PLAN_PROGRESS_LABEL, paymentPlanIssue, planProgress, suggestPaymentPlan, type PlanInvoiceInput } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { paymentPlans, type PaymentPlanDoc } from '../db/collections/payment-plans';
import { roundPg, withOpen } from '../db/subledger-queries';

const ref = (n: number) => `PP-${String(n).padStart(3, '0')}`;

export interface SuggestInput {
  contactId: string;
  instalments?: number;
  firstDueDate?: string;
}

/**
 * Suggested payment plans (AR-040). For each customer with an overdue balance not in dispute, a
 * suggested instalment plan sized to what they have paid a month lately; a member who manages
 * collections agrees a plan (the amounts are worked out here, never taken from the request), and
 * every plan shows how it is going from what has been received against its invoices since. A
 * plan only changes by being cancelled, and both are audited.
 */
@Injectable()
export class PaymentPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  /** Open invoices in the functional currency, with open disputes; and receipts by customer in the last 6 months. */
  private async facts(org: OrgContext, today: string) {
    const asOf = toDbDate(today);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'INVOICE', status: 'POSTED', issueDate: { lte: asOf } },
      select: { id: true, contactId: true, number: true, dueDate: true, total: true, exchangeRate: true },
    });
    const rows = await withOpen(this.prisma, org.id, docs, asOf);
    const openF = new Map(rows.map((r) => [r.id, roundPg(r.open.times(r.exchangeRate), 2)]));
    const open = rows.filter((r) => r.open.gt(0));
    const [disputes, receipts] = await Promise.all([
      open.length ? this.prisma.invoiceDispute.findMany({ where: { orgId: org.id, status: 'OPEN', documentId: { in: open.map((r) => r.id) } }, select: { documentId: true } }) : [],
      this.prisma.payment.findMany({ where: { orgId: org.id, kind: 'RECEIPT', status: 'POSTED', date: { gte: toDbDate(addDays(today, -180)), lte: asOf } }, select: { contactId: true, date: true, amount: true, exchangeRate: true } }),
    ]);
    const disputed = new Set(disputes.map((d) => d.documentId));
    const invoicesOf = new Map<string, PlanInvoiceInput[]>();
    for (const r of open) {
      const list = invoicesOf.get(r.contactId) ?? [];
      list.push({ id: r.id, number: r.number ?? '', dueDate: fromDbDate(r.dueDate), outstanding: openF.get(r.id)!.toFixed(), disputed: disputed.has(r.id) });
      invoicesOf.set(r.contactId, list);
    }
    const receiptsOf = new Map<string, { date: string; amount: string }[]>();
    for (const p of receipts) {
      const list = receiptsOf.get(p.contactId) ?? [];
      list.push({ date: fromDbDate(p.date), amount: roundPg(p.amount.times(p.exchangeRate), 2).toFixed() });
      receiptsOf.set(p.contactId, list);
    }
    return { openF, invoicesOf, receiptsOf };
  }

  private progress(p: PaymentPlanDoc, openF: Map<string, InstanceType<typeof D>>, today: string) {
    // Received since the plan was agreed: what each invoice owed then, less what it owes now. An
    // invoice no longer open (paid, credited or voided) owes nothing now.
    const paid = p.invoices.reduce((s, i) => s.plus(D.max(new D(i.outstanding).minus((openF.get(i.id) ?? new D(0)).toString()), new D(0))), new D(0));
    return planProgress(p.instalments, paid.toFixed(), today, minorUnits(p.currency), p.status === 'CANCELLED');
  }

  private async names(ids: string[]) {
    const list = ids.length ? await this.prisma.contact.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(list.map((c) => [c.id, c]));
  }

  private view(p: PaymentPlanDoc, openF: Map<string, InstanceType<typeof D>>, today: string, customer: string) {
    const progress = this.progress(p, openF, today);
    return {
      id: p.id,
      reference: ref(p.number),
      contactId: p.contactId,
      customer,
      currency: p.currency,
      total: p.total,
      invoices: p.invoices,
      suggestedInstalments: p.suggestedInstalments,
      note: p.note,
      status: progress.status,
      statusLabel: PLAN_PROGRESS_LABEL[progress.status],
      progress,
      createdAt: p.createdAt.toISOString(),
      cancelledAt: p.cancelledAt?.toISOString() ?? null,
      cancelReason: p.cancelReason,
    };
  }

  /** Plans still running: agreed, not cancelled and not yet paid off. */
  private running(plans: PaymentPlanDoc[], openF: Map<string, InstanceType<typeof D>>, today: string) {
    return plans.filter((p) => p.status === 'ACTIVE' && this.progress(p, openF, today).status !== 'COMPLETED');
  }

  /** Every plan with its progress, and the customers a plan could be offered to, each with a suggestion. */
  async list(org: OrgContext, today = todayIso()) {
    const s = minorUnits(org.functionalCurrency);
    const [{ openF, invoicesOf, receiptsOf }, plans] = await Promise.all([this.facts(org, today), this.store.collection(paymentPlans).find({}, { sort: { number: -1 } })]);
    const running = this.running(plans, openF, today);
    const onPlan = new Set(running.map((p) => p.contactId));
    const candidates = [...invoicesOf.entries()]
      .filter(([contactId]) => !onPlan.has(contactId))
      .map(([contactId, invoices]) => ({ contactId, suggestion: suggestPaymentPlan(invoices, receiptsOf.get(contactId) ?? [], today, s) }))
      .filter((c) => !!c.suggestion);
    const names = await this.names([...plans.map((p) => p.contactId), ...candidates.map((c) => c.contactId)]);
    const views = plans.map((p) => this.view(p, openF, today, names.get(p.contactId)?.name ?? 'Unknown customer'));
    const live = views.filter((v) => v.status !== 'CANCELLED' && v.status !== 'COMPLETED');
    const sum = (xs: string[]) => xs.reduce((t, x) => t.plus(x), new D(0)).toFixed(s);
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: {
        running: live.length,
        onTrack: live.filter((v) => v.status === 'ON_TRACK').length,
        behind: live.filter((v) => v.status === 'BEHIND').length,
        broken: live.filter((v) => v.status === 'BROKEN').length,
        completed: views.filter((v) => v.status === 'COMPLETED').length,
        remaining: sum(live.map((v) => v.progress.remaining)),
        behindBy: sum(live.map((v) => v.progress.behindBy)),
        candidates: candidates.length,
      },
      candidates: candidates
        .map((c) => ({ contactId: c.contactId, customer: names.get(c.contactId)?.name ?? 'Unknown customer', ...c.suggestion! }))
        .sort((a, b) => new D(b.total).cmp(a.total) || a.customer.localeCompare(b.customer)),
      plans: views,
    };
  }

  /** A suggested plan for one customer, with the instalments and first date chosen or the recommended ones. */
  async suggest(org: OrgContext, q: SuggestInput, today = todayIso()) {
    if (q.instalments != null || q.firstDueDate) {
      const issue = paymentPlanIssue(q.instalments ?? 1, q.firstDueDate ?? today, today);
      if (issue) throw new DomainError('INVALID_PLAN', issue, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const contact = await this.prisma.contact.findFirst({ where: { orgId: org.id, id: q.contactId }, select: { id: true, name: true } });
    if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Customer not found' });
    const [{ openF, invoicesOf, receiptsOf }, plans] = await Promise.all([this.facts(org, today), this.store.collection(paymentPlans).find({ contactId: q.contactId })]);
    const running = this.running(plans, openF, today);
    const suggestion = suggestPaymentPlan(invoicesOf.get(q.contactId) ?? [], receiptsOf.get(q.contactId) ?? [], today, minorUnits(org.functionalCurrency), { instalments: q.instalments, firstDueDate: q.firstDueDate });
    return { asOf: today, currency: org.functionalCurrency, contactId: contact.id, customer: contact.name, runningPlan: running[0] ? ref(running[0].number) : null, suggestion };
  }

  async create(org: OrgContext, user: AuthUser, input: Required<Pick<SuggestInput, 'contactId'>> & SuggestInput & { note?: string | null }, today = todayIso()) {
    const s = await this.suggest(org, input, today);
    if (s.runningPlan) throw new DomainError('PLAN_RUNNING', `${s.customer} already has payment plan ${s.runningPlan}; cancel it first`, HttpStatus.CONFLICT);
    if (!s.suggestion) throw new DomainError('NOTHING_OVERDUE', `${s.customer} has nothing overdue that is not in dispute`, HttpStatus.UNPROCESSABLE_ENTITY);
    const g = s.suggestion;
    const number = await this.store.nextTenantSequence('payment_plan');
    const doc = await this.store.collection(paymentPlans).insertOne({
      number,
      contactId: s.contactId,
      currency: org.functionalCurrency,
      total: g.total,
      invoices: g.invoices.map((i) => ({ id: i.id, number: i.number, outstanding: i.outstanding })),
      instalments: g.schedule,
      suggestedInstalments: g.recommended,
      note: input.note?.trim() || null,
      status: 'ACTIVE',
      createdById: user.id,
      createdAt: new Date(),
      cancelledById: null,
      cancelledAt: null,
      cancelReason: null,
    });
    await this.log(org, user, 'payment_plan.agreed', doc.id, { reference: ref(number), contactId: s.contactId, total: g.total, instalments: g.instalments, suggested: g.recommended, firstDueDate: g.firstDueDate, invoices: g.invoices.map((i) => i.number) });
    return this.get(org, doc.id, today);
  }

  async get(org: OrgContext, id: string, today = todayIso()) {
    const p = await this.store.collection(paymentPlans).findById(id);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment plan not found' });
    const { openF } = await this.facts(org, today);
    const names = await this.names([p.contactId]);
    return this.view(p, openF, today, names.get(p.contactId)?.name ?? 'Unknown customer');
  }

  async cancel(org: OrgContext, user: AuthUser, id: string, reason: string, today = todayIso()) {
    const p = await this.store.collection(paymentPlans).findById(id);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment plan not found' });
    if (p.status === 'CANCELLED') throw new DomainError('ALREADY_CANCELLED', 'The plan is already cancelled', HttpStatus.CONFLICT);
    const r = await this.store.collection(paymentPlans).updateOne({ id, status: 'ACTIVE' }, { $set: { status: 'CANCELLED', cancelledById: user.id, cancelledAt: new Date(), cancelReason: reason.trim() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The plan changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'payment_plan.cancelled', id, { reference: ref(p.number), reason: reason.trim() });
    return this.get(org, id, today);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'payment_plan', entityId, data }));
  }
}

