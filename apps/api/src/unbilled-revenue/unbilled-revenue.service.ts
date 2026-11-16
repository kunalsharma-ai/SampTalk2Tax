import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  duePeriods,
  formatDateText,
  missedRecurringBilling,
  orderUnbilledAmount,
  periodLabel,
  proFormaRef,
  stillDismissed,
  UNBILLED_CONFIDENCE,
  UNBILLED_DRAFT_DAYS,
  UNBILLED_ORDER_DAYS,
  UNBILLED_SOURCES,
  unbilledAge,
  unbilledFingerprint,
  unbilledTotals,
  addDays,
  type ContractFrequency,
  type UnbilledFinding,
  type UnbilledSource,
} from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shiftMonth = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by + +month.slice(0, 4) * 12;
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
};
const pad = (n: number, w = 4) => String(n).padStart(w, '0');
const salesOrderRef = (n: number) => `SO-${pad(n)}`;
/** Look back this many months for a customer billed every month. */
const REGULAR_LOOKBACK = 3;

/** A finding with what the screen needs to show and open it. */
export interface UnbilledRow extends UnbilledFinding {
  fingerprint: string;
  confidence: string;
  customer: string;
  /** What it is, such as "SO-0004" or "Draft invoice dated 1 Nov 2026". */
  label: string;
  /** Where to bill it, inside the organisation. */
  path: string;
  ageDays: number;
  dismissed: { reason: string; by: string | null; at: string; amount: string | null } | null;
}

/**
 * Unbilled revenue detection (AR-042): each source of revenue earned or agreed but not invoiced,
 * read from the records the app keeps. People dismiss a finding with a reason (kept as a history);
 * it comes back if its amount grows.
 */
@Injectable()
export class UnbilledRevenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async findings(orgId: string, today: string): Promise<(UnbilledFinding & { label: string; path: string })[]> {
    const out: (UnbilledFinding & { label: string; path: string })[] = [];
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });

    // Milestones completed with no live invoice.
    const milestones = await this.prisma.salesOrderMilestone.findMany({
      where: { orgId, completedAt: { not: null }, order: { status: 'OPEN' } },
      include: { order: { select: { id: true, number: true, contactId: true, currency: true, subtotal: true } } },
    });
    const msDocs = new Map((await this.prisma.document.findMany({ where: { orgId, id: { in: milestones.flatMap((m) => (m.documentId ? [m.documentId] : [])) } }, select: { id: true, status: true } })).map((d) => [d.id, d.status]));
    for (const m of milestones) {
      if (m.documentId && msDocs.get(m.documentId) !== 'VOID') continue;
      out.push({
        source: 'MILESTONE',
        refId: m.id,
        contactId: m.order.contactId,
        currency: m.order.currency,
        amount: new D(m.order.subtotal.toString()).times(m.percent.toString()).div(100).toDecimalPlaces(2).toFixed(2),
        since: istDate(m.completedAt!),
        label: `${salesOrderRef(m.order.number)}: ${m.name}`,
        path: `/sales/orders/${m.order.id}`,
        detail: `Milestone "${m.name}" (${new D(m.percent.toString()).toFixed()}% of ${salesOrderRef(m.order.number)}) was marked complete${m.documentId ? ' and its invoice was voided' : ''}, but has no invoice.`,
      });
    }

    // Orders billed on delivery with quantity left a month after their date.
    const orders = await this.prisma.salesOrder.findMany({
      where: { orgId, status: 'OPEN', billingMethod: 'DELIVERY', orderDate: { lte: new Date(`${addDays(today, -UNBILLED_ORDER_DAYS)}T00:00:00Z`) } },
      include: { lines: { include: { billings: true } } },
    });
    const orderDocs = new Map(
      (await this.prisma.document.findMany({ where: { orgId, id: { in: orders.flatMap((o) => o.lines.flatMap((l) => l.billings.map((b) => b.documentId))) } }, select: { id: true, status: true } })).map((d) => [d.id, d.status]),
    );
    for (const o of orders) {
      const lines = o.lines.map((l) => ({
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        billed: l.billings.filter((b) => orderDocs.get(b.documentId) && orderDocs.get(b.documentId) !== 'VOID').reduce((t, b) => t.plus(b.quantity.toString()), new D(0)).toFixed(),
      }));
      const amount = orderUnbilledAmount(lines);
      if (new D(amount).lte(0)) continue;
      const started = lines.some((l) => new D(l.billed).gt(0));
      out.push({
        source: 'ORDER',
        refId: o.id,
        contactId: o.contactId,
        currency: o.currency,
        amount,
        since: fromDbDate(o.orderDate),
        label: salesOrderRef(o.number),
        path: `/sales/orders/${o.id}`,
        detail: `${salesOrderRef(o.number)} dated ${formatDateText(fromDbDate(o.orderDate))} is ${started ? 'partly billed' : 'not billed at all'} more than ${UNBILLED_ORDER_DAYS} days on. If the goods or services went out, invoice them; if the order will not be delivered, cancel it.`,
      });
    }

    // Contract periods due and not billed.
    const contracts = await this.prisma.salesContract.findMany({
      where: { orgId, status: 'ACTIVE' },
      select: { id: true, number: true, title: true, contactId: true, currency: true, status: true, frequency: true, timing: true, startDate: true, endDate: true, nextPeriodNo: true, subtotal: true, lastError: true },
    });
    for (const c of contracts) {
      const due = duePeriods({ start: fromDbDate(c.startDate), end: c.endDate ? fromDbDate(c.endDate) : null, frequency: c.frequency as ContractFrequency, timing: c.timing, nextNo: c.nextPeriodNo }, today);
      if (!due.length) continue;
      const ref = `CT-${pad(c.number)}`;
      out.push({
        source: 'CONTRACT_PERIOD',
        refId: c.id,
        contactId: c.contactId,
        currency: c.currency,
        amount: new D(c.subtotal.toString()).times(due.length).toDecimalPlaces(2).toFixed(2),
        since: due[0]!.billDate,
        label: `${ref} ${c.title}`,
        path: `/sales/contracts/${c.id}`,
        detail: `${due.length === 1 ? 'The period' : `${due.length} periods`} ${due.map((p) => periodLabel(p)).join('; ')} ${due.length === 1 ? 'was' : 'were'} due for invoicing and ${due.length === 1 ? 'has' : 'have'} no invoice.${c.lastError ? ` The last attempt failed: ${c.lastError}` : ''}`,
      });
    }
    // Draft invoices left waiting.
    const drafts = await this.prisma.document.findMany({ where: { orgId, kind: 'INVOICE', status: 'DRAFT', issueDate: { lte: new Date(`${addDays(today, -UNBILLED_DRAFT_DAYS)}T00:00:00Z`) } }, select: { id: true, contactId: true, currency: true, subtotal: true, issueDate: true, reference: true } });
    for (const d of drafts) {
      out.push({
        source: 'DRAFT_INVOICE',
        refId: d.id,
        contactId: d.contactId,
        currency: d.currency,
        amount: new D(d.subtotal.toString()).toFixed(2),
        since: fromDbDate(d.issueDate),
        label: `Draft invoice dated ${formatDateText(fromDbDate(d.issueDate))}${d.reference ? ` (${d.reference})` : ''}`,
        path: `/sales/invoices/${d.id}`,
        detail: `A draft invoice dated ${formatDateText(fromDbDate(d.issueDate))} has not been posted or sent, more than ${UNBILLED_DRAFT_DAYS} days on. Post it, or delete it if it is not needed.`,
      });
    }

    // Pro forma invoices issued, expired, and never turned into a tax invoice.
    const proFormas = await this.prisma.proFormaInvoice.findMany({ where: { orgId, status: 'ISSUED', validUntil: { lt: new Date(`${today}T00:00:00Z`) } }, select: { id: true, number: true, contactId: true, currency: true, subtotal: true, validUntil: true, invoiceId: true } });
    const pfInvoices = new Map((await this.prisma.document.findMany({ where: { orgId, id: { in: proFormas.flatMap((p) => (p.invoiceId ? [p.invoiceId] : [])) } }, select: { id: true, status: true } })).map((d) => [d.id, d.status]));
    for (const p of proFormas) {
      if (p.invoiceId && pfInvoices.get(p.invoiceId) !== 'VOID') continue;
      const ref = proFormaRef(p.number);
      out.push({
        source: 'PRO_FORMA',
        refId: p.id,
        contactId: p.contactId,
        currency: p.currency,
        amount: new D(p.subtotal.toString()).toFixed(2),
        since: fromDbDate(p.validUntil),
        label: ref,
        path: `/sales/pro-formas/${p.id}`,
        detail: `${ref} was issued and ran out on ${formatDateText(fromDbDate(p.validUntil))} without a tax invoice. If the customer went ahead (or paid), make the invoice; otherwise cancel the pro forma.`,
      });
    }

    // Customers invoiced every month who were not invoiced last month.
    const month = shiftMonth(today.slice(0, 7), -1);
    const rows = await this.prisma.$queryRaw<{ contact_id: string; month: string; amount: { toString(): string } }[]>`
      SELECT d.contact_id, to_char(d.issue_date, 'YYYY-MM') AS month, SUM(CASE WHEN d.kind = 'INVOICE' THEN d.subtotal * d.exchange_rate ELSE -d.subtotal * d.exchange_rate END) AS amount
      FROM documents d
      WHERE d.org_id = ${orgId}::uuid AND d.kind IN ('INVOICE', 'CREDIT_NOTE') AND d.status = 'POSTED'
        AND d.issue_date >= ${`${shiftMonth(month, -REGULAR_LOOKBACK)}-01`}::date AND d.issue_date < ${`${shiftMonth(month, 1)}-01`}::date
      GROUP BY 1, 2`;
    const flagged = new Set(out.map((f) => f.contactId));
    for (const m of missedRecurringBilling(rows.map((r) => ({ contactId: r.contact_id, month: r.month, amount: r.amount.toString() })), month, REGULAR_LOOKBACK)) {
      // A customer with a draft or contract period already flagged is covered there.
      if (flagged.has(m.contactId)) continue;
      out.push({
        source: 'REGULAR_CUSTOMER',
        refId: m.contactId,
        contactId: m.contactId,
        currency: org.functionalCurrency,
        amount: m.typical.toDecimalPlaces(2).toFixed(2),
        since: `${shiftMonth(month, 1)}-01`,
        label: `No invoice in ${month}`,
        path: `/sales/customers/${m.contactId}`,
        detail: `Invoiced in each of the ${REGULAR_LOOKBACK} months before ${month} (usually ${m.typical.toDecimalPlaces(2).toFixed(2)} a month before tax), but not in ${month}. Check whether work done last month was billed.`,
      });
    }
    return out;
  }

  async report(orgId: string) {
    const today = todayIst();
    const found = await this.findings(orgId, today);
    const [contacts, dismissals] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId, id: { in: [...new Set(found.map((f) => f.contactId))] } }, select: { id: true, name: true } }),
      this.prisma.unbilledRevenueDismissal.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const name = new Map(contacts.map((c) => [c.id, c.name]));
    const latest = new Map<string, (typeof dismissals)[number]>();
    for (const d of dismissals) if (!latest.has(d.fingerprint)) latest.set(d.fingerprint, d);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(dismissals.map((d) => d.byId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const rows: UnbilledRow[] = found.map((f) => {
      const fingerprint = unbilledFingerprint(f);
      const d = latest.get(fingerprint);
      const hidden = stillDismissed(f, d ? { action: d.action as 'DISMISS' | 'RESTORE', amount: d.amount?.toString() ?? null } : null);
      return {
        ...f,
        fingerprint,
        confidence: UNBILLED_CONFIDENCE[f.source],
        customer: name.get(f.contactId) ?? '',
        ageDays: unbilledAge(f.since, today),
        dismissed: hidden && d ? { reason: d.reason, by: users.get(d.byId) ?? null, at: istDate(d.createdAt), amount: d.amount ? new D(d.amount.toString()).toFixed(2) : null } : null,
      };
    });
    const order = Object.fromEntries(UNBILLED_SOURCES.map((s, i) => [s, i])) as Record<UnbilledSource, number>;
    rows.sort((a, b) => order[a.source] - order[b.source] || b.ageDays - a.ageDays || a.customer.localeCompare(b.customer));
    const open = rows.filter((r) => !r.dismissed);
    return {
      asOf: today,
      currency: (await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } })).functionalCurrency,
      totals: unbilledTotals(open),
      counts: { open: open.length, dismissed: rows.length - open.length },
      findings: rows,
    };
  }

  /** Dismiss a finding with a reason, or bring a dismissed one back. */
  async dismiss(orgId: string, actor: Actor, input: { fingerprint: string; action: 'DISMISS' | 'RESTORE'; reason: string }) {
    const r = await this.report(orgId);
    const f = r.findings.find((x) => x.fingerprint === input.fingerprint);
    if (!f) throw new NotFoundException({ error: 'NOT_FOUND', message: 'That finding is no longer there; it may have been billed' });
    if (input.action === 'DISMISS' && f.dismissed) throw new DomainError('UNBILLED_ALREADY_DISMISSED', 'This finding is already dismissed', HttpStatus.CONFLICT);
    if (input.action === 'RESTORE' && !f.dismissed) throw new DomainError('UNBILLED_NOT_DISMISSED', 'This finding is not dismissed', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.unbilledRevenueDismissal.create({ data: { orgId, fingerprint: f.fingerprint, action: input.action, amount: f.amount, currency: f.currency, reason: input.reason.trim(), byId: actor.id } });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: input.action === 'DISMISS' ? 'unbilled_revenue.dismissed' : 'unbilled_revenue.restored',
        entityType: 'unbilled_revenue_dismissal',
        entityId: row.id,
        data: { fingerprint: f.fingerprint, source: f.source, refId: f.refId, amount: f.amount, currency: f.currency, reason: input.reason.trim() },
      });
    });
    return this.report(orgId);
  }
}
