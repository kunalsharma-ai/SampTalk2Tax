import { Injectable, NotFoundException } from '@nestjs/common';
import { addDays, D, dec, minorUnits, NEGOTIATION_POINT_LABEL, negotiationBrief, negotiationItemKey, PAYMENT_RECORD_LABEL, roundToCurrency, type MarketPrice, type NegotiationBill } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { withOpen } from '../db/subledger-queries';
import { todayIst } from '../tasks/tasks.service';
import { VendorPerformanceService } from '../vendor-performance/vendor-performance.service';

/**
 * Supplier negotiation help (AP-033): for every vendor billed in the twelve months to today, a
 * brief of where the organisation has leverage (price rises, cheaper vendors for the same item,
 * volume, its own payment record, the vendor's scorecard) with the savings the books can show.
 * Read-only; the engine's negotiationBrief explains every figure.
 */
@Injectable()
export class SupplierNegotiationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly performance: VendorPerformanceService,
  ) {}

  private async briefs(org: OrgContext, today: string) {
    const ccy = org.functionalCurrency;
    const since = addDays(today, -364);
    const before = addDays(since, -365);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: { in: ['BILL', 'VENDOR_CREDIT'] }, status: 'POSTED', issueDate: { gte: toDbDate(before), lte: toDbDate(today) } },
      select: { id: true, kind: true, contactId: true, issueDate: true, dueDate: true, subtotal: true, total: true, exchangeRate: true, lines: { select: { description: true, hsnCode: true, quantity: true, unitPrice: true } } },
    });
    const current = docs.filter((d) => fromDbDate(d.issueDate) >= since);
    const bills = await withOpen(this.prisma, org.id, current.filter((d) => d.kind === 'BILL'), toDbDate(today));
    const fx = (d: (typeof docs)[number]) => roundToCurrency(dec(d.subtotal.toString()).times(dec(d.exchangeRate.toString())), ccy);
    const vendorIds = [...new Set(bills.map((b) => b.contactId))];
    const [contacts, grades] = await Promise.all([
      vendorIds.length ? this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: vendorIds }, isVendor: true }, select: { id: true, name: true, paymentTermsDays: true } }) : [],
      vendorIds.length ? this.performance.gradesAndSpend(org.id) : new Map(),
    ]);
    const names = new Map(contacts.map((c) => [c.id, c.name]));
    const byVendor = new Map<string, NegotiationBill[]>();
    const market: MarketPrice[] = [];
    for (const b of bills) {
      const issueDate = fromDbDate(b.issueDate);
      byVendor.set(b.contactId, [
        ...(byVendor.get(b.contactId) ?? []),
        {
          id: b.id,
          issueDate,
          dueDate: fromDbDate(b.dueDate),
          exchangeRate: b.exchangeRate.toString(),
          subtotal: b.subtotal.toString(),
          paidOn: b.open.lte(0) && b.lastAllocated ? fromDbDate(b.lastAllocated) : null,
          lines: b.lines.map((l) => ({ description: l.description, hsnCode: l.hsnCode, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() })),
        },
      ]);
      for (const l of b.lines) {
        const key = negotiationItemKey(l);
        if (key && l.quantity.gt(0) && names.has(b.contactId)) market.push({ vendorId: b.contactId, vendorName: names.get(b.contactId)!, key, issueDate, unitPrice: dec(l.unitPrice.toString()).times(dec(b.exchangeRate.toString())).toFixed() });
      }
    }
    const spendOf = (list: typeof docs) => list.reduce((a, d) => (d.kind === 'BILL' ? a.plus(fx(d)) : a.minus(fx(d))), new D(0));
    const credits = (id: string) => spendOf(current.filter((d) => d.kind === 'VENDOR_CREDIT' && d.contactId === id));
    const totalSpend = spendOf(current.filter((d) => names.has(d.contactId)));
    const m = minorUnits(ccy);
    return contacts.map((c) =>
      negotiationBrief({
        vendor: { id: c.id, name: c.name, paymentTermsDays: c.paymentTermsDays },
        bills: byVendor.get(c.id) ?? [],
        credits: credits(c.id).negated().toFixed(m),
        previousSpend: spendOf(docs.filter((d) => d.contactId === c.id && fromDbDate(d.issueDate) < since)).toFixed(m),
        totalSpend: totalSpend.toFixed(m),
        market,
        grade: grades.get(c.id)?.grade ?? null,
        today,
        currency: ccy,
      }),
    );
  }

  /** Every vendor billed in the last twelve months, the largest possible saving first. */
  async list(org: OrgContext, today = todayIst()) {
    const all = await this.briefs(org, today);
    const vendors = all
      .map((b) => ({
        vendor: { id: b.vendor.id, name: b.vendor.name },
        spend: b.spend.current,
        change: b.spend.change,
        share: b.spend.share,
        bills: b.spend.bills,
        grade: b.grade,
        paymentRecord: b.payments.record,
        paymentRecordLabel: PAYMENT_RECORD_LABEL[b.payments.record],
        points: b.points.map((p) => ({ code: p.code, label: NEGOTIATION_POINT_LABEL[p.code], tone: p.tone })),
        targetSaving: b.targetSaving,
      }))
      .sort((a, b) => dec(b.targetSaving).cmp(dec(a.targetSaving)) || b.points.length - a.points.length || dec(b.spend).cmp(dec(a.spend)) || a.vendor.name.localeCompare(b.vendor.name));
    return {
      asOf: today,
      from: addDays(today, -364),
      currency: org.functionalCurrency,
      summary: {
        vendors: vendors.length,
        withPoints: vendors.filter((v) => v.points.some((p) => p.tone === 'ASK')).length,
        targetSaving: all.reduce((a, b) => a.plus(dec(b.targetSaving)), new D(0)).toFixed(minorUnits(org.functionalCurrency)),
      },
      vendors,
    };
  }

  /** One vendor's brief: spend, payment record, items with prices, and the points to raise. */
  async detail(org: OrgContext, contactId: string, today = todayIst()) {
    const vendor = await this.prisma.contact.findFirst({ where: { orgId: org.id, id: contactId, isVendor: true }, select: { id: true, name: true, paymentTermsDays: true } });
    if (!vendor) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor not found' });
    const brief = (await this.briefs(org, today)).find((b) => b.vendor.id === contactId);
    const empty = brief ?? negotiationBrief({ vendor, bills: [], credits: '0', previousSpend: '0', totalSpend: '0', market: [], grade: null, today, currency: org.functionalCurrency });
    return {
      asOf: today,
      from: addDays(today, -364),
      currency: org.functionalCurrency,
      ...empty,
      paymentRecordLabel: PAYMENT_RECORD_LABEL[empty.payments.record],
      points: empty.points.map((p) => ({ ...p, label: NEGOTIATION_POINT_LABEL[p.code] })),
    };
  }
}
