import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, D, purchaseOrderRef, reviewIssues, vendorScorecard, type PerfBill, type PerfBillLine, type PerfOrder, type PerfReview, type VendorScorecard } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
export interface Period {
  from?: string;
  to?: string;
}

/**
 * Vendor performance (AP-021): a scorecard per vendor worked out from their purchase orders, goods
 * receipts and posted bills in a period (the engine's vendorScorecard explains every figure), and
 * the team's own reviews, which are kept for good: the author can withdraw one, never edit it.
 */
@Injectable()
export class VendorPerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private invalid(message: string, code = 'VENDOR_REVIEW_INVALID', details?: unknown): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  private can(org: OrgContext) {
    return { review: hasPermission(org.role, 'purchases.manage') };
  }

  /** The period, by default the twelve months to today. */
  private period(p: Period) {
    const today = todayIst();
    const to = p.to ?? today;
    const from = p.from ?? addDays(to, -364);
    if (from > to) this.invalid('The period starts after it ends', 'PERIOD_INVALID');
    return { from, to, today };
  }

  /** Everything the scorecards need for some vendors in a period, grouped by vendor. */
  private async facts(orgId: string, contactIds: string[] | null, from: string, to: string) {
    const who = contactIds ? { contactId: { in: contactIds } } : {};
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    const [orders, bills, credits, reviews] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { orgId, ...who, orderDate: range, status: { not: 'DRAFT' } },
        include: { lines: true, receipts: { where: { status: 'RECORDED' }, include: { lines: true } } },
      }),
      this.prisma.document.findMany({
        where: { orgId, ...who, kind: 'BILL', status: 'POSTED', issueDate: range },
        select: { id: true, contactId: true, issueDate: true, subtotal: true, exchangeRate: true, purchaseOrderId: true, lines: { where: { purchaseOrderLineId: { not: null } }, select: { purchaseOrderLineId: true, quantity: true, unitPrice: true } } },
      }),
      this.prisma.document.findMany({ where: { orgId, ...who, kind: 'VENDOR_CREDIT', status: 'POSTED', issueDate: range }, select: { contactId: true, subtotal: true, exchangeRate: true } }),
      this.prisma.vendorReview.findMany({ where: { orgId, ...who, reviewDate: range, withdrawnAt: null }, select: { contactId: true, rating: true } }),
    ]);
    const accepted = new Set(
      (await this.prisma.billMatchAcceptance.findMany({ where: { orgId, documentId: { in: bills.filter((b) => b.purchaseOrderId).map((b) => b.id) } }, select: { documentId: true } })).map((a) => a.documentId),
    );
    const byVendor = new Map<string, { orders: PerfOrder[]; bills: PerfBill[]; billLines: PerfBillLine[]; vendorCredits: { subtotal: string }[]; reviews: PerfReview[] }>();
    const of = (id: string) => {
      let v = byVendor.get(id);
      if (!v) byVendor.set(id, (v = { orders: [], bills: [], billLines: [], vendorCredits: [], reviews: [] }));
      return v;
    };
    // Bills may be linked to orders placed before the period; their order lines are needed for prices.
    const known = new Set(orders.flatMap((o) => o.lines.map((l) => l.id)));
    const missing = [...new Set(bills.flatMap((b) => b.lines.map((l) => l.purchaseOrderLineId!)).filter((id) => !known.has(id)))];
    const extraLines = missing.length ? await this.prisma.purchaseOrderLine.findMany({ where: { orgId, id: { in: missing } }, select: { id: true, quantity: true, unitPrice: true, order: { select: { contactId: true } } } }) : [];
    for (const o of orders) {
      of(o.contactId).orders.push({
        id: o.id,
        ref: purchaseOrderRef(o.number),
        orderDate: fromDbDate(o.orderDate),
        expectedDate: o.expectedDate ? fromDbDate(o.expectedDate) : null,
        status: o.status,
        lines: o.lines.map((l) => ({ id: l.id, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() })),
        receipts: o.receipts.flatMap((r) => r.lines.map((l) => ({ orderLineId: l.orderLineId, date: fromDbDate(r.receiptDate), quantity: l.quantity.toString(), rejected: l.rejected.toString() }))),
      });
    }
    // Order lines from before the period count for prices only: a stand-in order with no expected date.
    for (const l of extraLines) {
      of(l.order.contactId).orders.push({ id: `price:${l.id}`, ref: '', orderDate: from, expectedDate: null, status: 'PRICE_ONLY', lines: [{ id: l.id, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() }], receipts: [] });
    }
    for (const b of bills) {
      const v = of(b.contactId);
      v.bills.push({ id: b.id, issueDate: fromDbDate(b.issueDate), subtotal: new D(b.subtotal.toString()).times(b.exchangeRate.toString()).toFixed(2), linkedToOrder: !!b.purchaseOrderId, differencesAccepted: accepted.has(b.id) });
      for (const l of b.lines) v.billLines.push({ documentId: b.id, orderLineId: l.purchaseOrderLineId!, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), rate: b.exchangeRate.toString() });
    }
    for (const c of credits) of(c.contactId).vendorCredits.push({ subtotal: new D(c.subtotal.toString()).times(c.exchangeRate.toString()).toFixed(2) });
    for (const r of reviews) of(r.contactId).reviews.push({ rating: r.rating });
    return byVendor;
  }

  /** Price-only stand-in orders, and cancelled ones, are not counted as orders of the period. */
  private score(v: { orders: PerfOrder[]; bills: PerfBill[]; billLines: PerfBillLine[]; vendorCredits: { subtotal: string }[]; reviews: PerfReview[] }, today: string): VendorScorecard {
    const s = vendorScorecard({ ...v, today });
    return { ...s, orders: v.orders.filter((o) => !['PRICE_ONLY', 'DRAFT', 'CANCELLED'].includes(o.status)).length };
  }

  /** Grade and spend of every vendor with activity in the twelve months to today (for vendor risk, AP-024). */
  async gradesAndSpend(orgId: string): Promise<Map<string, { grade: VendorScorecard['grade']; spend: string }>> {
    const { from, to, today } = this.period({});
    const byVendor = await this.facts(orgId, null, from, to);
    return new Map([...byVendor].map(([id, v]) => {
      const s = this.score(v, today);
      return [id, { grade: s.grade, spend: s.billing.spend }];
    }));
  }

  /** Every vendor with orders, bills or reviews in the period, best score first. */
  async list(org: OrgContext, p: Period) {
    const { from, to, today } = this.period(p);
    const byVendor = await this.facts(org.id, null, from, to);
    const contacts = byVendor.size ? await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...byVendor.keys()] } }, select: { id: true, name: true, isVendor: true } }) : [];
    const vendors = contacts
      .filter((c) => c.isVendor)
      .map((c) => {
        const s = this.score(byVendor.get(c.id)!, today);
        return {
          contact: { id: c.id, name: c.name },
          score: s.score,
          grade: s.grade,
          orders: s.orders,
          onTimePercent: s.delivery.onTimePercent,
          late: s.delivery.late + s.delivery.overdue,
          rejectedPercent: s.quality.rejectedPercent,
          accuracyPercent: s.billing.accuracyPercent,
          overcharge: s.price.overcharge,
          spend: s.billing.spend,
          reviews: s.reviews,
        };
      })
      .sort((a, b) => (b.score === null ? -1 : 0) - (a.score === null ? -1 : 0) || new D(b.score ?? 0).cmp(a.score ?? 0) || a.contact.name.localeCompare(b.contact.name));
    const graded = vendors.filter((v) => v.grade);
    return {
      from,
      to,
      currency: org.functionalCurrency,
      vendors,
      counts: { A: graded.filter((v) => v.grade === 'A').length, B: graded.filter((v) => v.grade === 'B').length, C: graded.filter((v) => v.grade === 'C').length, D: graded.filter((v) => v.grade === 'D').length, ungraded: vendors.length - graded.length },
      can: this.can(org),
    };
  }

  private async vendor(orgId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({ where: { orgId, id: contactId, isVendor: true }, select: { id: true, name: true } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor not found' });
    return c;
  }

  /** One vendor's scorecard, its orders' delivery, and every review (withdrawn ones included). */
  async detail(org: OrgContext, actor: Actor, contactId: string, p: Period) {
    const { from, to, today } = this.period(p);
    const c = await this.vendor(org.id, contactId);
    const v = (await this.facts(org.id, [c.id], from, to)).get(c.id) ?? { orders: [], bills: [], billLines: [], vendorCredits: [], reviews: [] };
    const [reviews, orders] = await Promise.all([
      this.prisma.vendorReview.findMany({ where: { orgId: org.id, contactId: c.id }, orderBy: [{ reviewDate: 'desc' }, { createdAt: 'desc' }], take: 200 }),
      this.prisma.purchaseOrder.findMany({ where: { orgId: org.id, contactId: c.id, status: { not: 'DRAFT' } }, orderBy: { orderDate: 'desc' }, take: 100, select: { id: true, number: true, orderDate: true } }),
    ]);
    const ids = [...new Set(reviews.flatMap((r) => [r.createdById, r.withdrawnById].filter((x): x is string => !!x)))];
    const users = new Map((ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } }) : []).map((u) => [u.id, u.name || u.email]));
    const ref = new Map(orders.map((o) => [o.id, purchaseOrderRef(o.number)]));
    return {
      contact: c,
      from,
      to,
      currency: org.functionalCurrency,
      scorecard: this.score(v, today),
      reviews: reviews.map((r) => ({
        id: r.id,
        reviewDate: fromDbDate(r.reviewDate),
        aspect: r.aspect,
        rating: r.rating,
        note: r.note,
        order: r.orderId ? { id: r.orderId, ref: ref.get(r.orderId) ?? '' } : null,
        by: users.get(r.createdById) ?? '',
        mine: r.createdById === actor.id,
        withdrawn: r.withdrawnAt ? { at: r.withdrawnAt.toISOString(), by: users.get(r.withdrawnById!) ?? '', reason: r.withdrawReason } : null,
        createdAt: r.createdAt.toISOString(),
      })),
      orders: orders.map((o) => ({ id: o.id, ref: purchaseOrderRef(o.number), orderDate: fromDbDate(o.orderDate) })),
      can: this.can(org),
    };
  }

  async review(org: OrgContext, actor: Actor, contactId: string, input: { aspect: string; rating: number; note?: string | null; orderId?: string | null; reviewDate?: string | null }) {
    const c = await this.vendor(org.id, contactId);
    const note = input.note?.trim() ? input.note.trim() : null;
    const issues = reviewIssues({ rating: input.rating, aspect: input.aspect, note });
    if (issues.length) this.invalid(issues[0]!, 'VENDOR_REVIEW_INVALID', { issues });
    const date = input.reviewDate ?? todayIst();
    if (date > todayIst()) this.invalid('A review cannot be dated in the future');
    if (input.orderId && !(await this.prisma.purchaseOrder.findFirst({ where: { orgId: org.id, id: input.orderId, contactId: c.id }, select: { id: true } }))) {
      this.invalid('That purchase order is not from this vendor');
    }
    const r = await this.prisma.$transaction(async (tx) => {
      const row = await tx.vendorReview.create({ data: { orgId: org.id, contactId: c.id, orderId: input.orderId ?? null, reviewDate: toDbDate(date), aspect: input.aspect, rating: input.rating, note, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_review.created', entityType: 'vendor_review', entityId: row.id, data: { contactId: c.id, aspect: input.aspect, rating: input.rating, orderId: input.orderId ?? null } });
      return row;
    });
    return { id: r.id };
  }

  async withdraw(org: OrgContext, actor: Actor, contactId: string, reviewId: string, reason: string) {
    await this.vendor(org.id, contactId);
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.vendorReview.findFirst({ where: { orgId: org.id, contactId, id: reviewId } });
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Review not found' });
      if (r.createdById !== actor.id) throw new DomainError('NOT_AUTHOR', 'Only the person who wrote a review can withdraw it', HttpStatus.FORBIDDEN);
      if (r.withdrawnAt) throw new DomainError('ALREADY_WITHDRAWN', 'This review has already been withdrawn', HttpStatus.CONFLICT);
      await tx.vendorReview.update({ where: { id: r.id }, data: { withdrawnAt: new Date(), withdrawnById: actor.id, withdrawReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'vendor_review.withdrawn', entityType: 'vendor_review', entityId: r.id, data: { reason: reason.trim() } });
    });
    return { ok: true };
  }
}
