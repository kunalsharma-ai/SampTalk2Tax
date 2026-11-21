import { Injectable } from '@nestjs/common';
import { backtestPredictions, D, minorUnits, predictionSummary, predictOpenInvoices, type OpenInvoiceForPrediction, type PaidInvoiceForPrediction } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { roundPg, withOpen } from '../db/subledger-queries';

/**
 * Predictive payment-delay scoring (AR-033): every open invoice with the days after its due date it
 * is likely to be paid, the chance it is late, the likely date the money arrives and why, from the
 * organisation's own payment history; and how accurate the same method has been on invoices
 * already paid. Read-only. Amounts are in the functional currency.
 */
@Injectable()
export class PaymentPredictionsService {
  constructor(private readonly prisma: PrismaService) {}

  async predictions(org: OrgContext, q: { contactId?: string } = {}, today = todayIso()) {
    const asOf = toDbDate(today);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'INVOICE', status: 'POSTED', issueDate: { lte: asOf } },
      select: { id: true, contactId: true, number: true, issueDate: true, dueDate: true, total: true, exchangeRate: true },
    });
    const rows = (await withOpen(this.prisma, org.id, docs, asOf)).map((d) => ({
      ...d,
      totalF: roundPg(d.total.times(d.exchangeRate), 2),
      openF: roundPg(d.open.times(d.exchangeRate), 2),
    }));
    const paid: PaidInvoiceForPrediction[] = rows
      .filter((r) => r.open.lte(0) && r.lastAllocated)
      .map((r) => ({ contactId: r.contactId, issueDate: fromDbDate(r.issueDate), dueDate: fromDbDate(r.dueDate), paidOn: fromDbDate(r.lastAllocated!), total: r.totalF.toFixed() }));
    const open: OpenInvoiceForPrediction[] = rows
      .filter((r) => r.open.gt(0))
      .map((r) => ({ id: r.id, contactId: r.contactId, issueDate: fromDbDate(r.issueDate), dueDate: fromDbDate(r.dueDate), total: r.totalF.toFixed(), outstanding: r.openF.toFixed() }));
    const s = minorUnits(org.functionalCurrency);
    const byId = new Map(rows.map((r) => [r.id, r]));
    let predicted = predictOpenInvoices(open, paid, today);
    if (q.contactId) predicted = predicted.filter((p) => p.contactId === q.contactId);
    const ids = [...new Set(predicted.map((p) => p.contactId))];
    const names = new Map((ids.length ? await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: ids } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    const invoices = predicted
      .map((p) => {
        const d = byId.get(p.invoiceId)!;
        return {
          ...p,
          number: d.number,
          customer: names.get(p.contactId) ?? 'Unknown customer',
          issueDate: fromDbDate(d.issueDate),
          dueDate: fromDbDate(d.dueDate),
          total: d.totalF.toFixed(s),
          outstanding: d.openF.toFixed(s),
        };
      })
      .sort((a, b) => b.lateChance - a.lateChance || b.expectedDaysLate - a.expectedDaysLate || new D(b.outstanding).cmp(a.outstanding) || a.dueDate.localeCompare(b.dueDate));
    const unscored = open.filter((o) => (!q.contactId || o.contactId === q.contactId) && !predicted.some((p) => p.invoiceId === o.id)).length;
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: { ...predictionSummary(invoices.map((i) => ({ prediction: i, outstanding: i.outstanding })), today, s), unscored, paidHistory: paid.length },
      accuracy: backtestPredictions(paid, today),
      invoices,
    };
  }
}
