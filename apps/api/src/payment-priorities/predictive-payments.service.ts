import { Injectable } from '@nestjs/common';
import { D, formatAmountText, minorUnits, PREDICTED_PAYMENT_LABEL, predictPaymentDates } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { PaymentScheduleService } from '../payment-batches/payment-schedule.service';
import { PaymentPredictionsService } from '../payment-predictions/payment-predictions.service';
import { PaymentPrioritiesService } from './payment-priorities.service';

export const PREDICTED_PLAN_NOTE = 'Predicted date (AP-034)';

/**
 * Predictive payment scheduling (AP-034): a suggested payment date for each open bill in the
 * functional currency over the next 30, 60 or 90 days, from the cash in the bank accounts and the
 * receipts expected from customers (AR-033), keeping the balance above a buffer. Read-only until
 * someone applies the dates, which become AP-007 payment plans.
 */
@Injectable()
export class PredictivePaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly priorities: PaymentPrioritiesService,
    private readonly predictions: PaymentPredictionsService,
    private readonly schedule: PaymentScheduleService,
  ) {}

  async predicted(org: OrgContext, q: { days: number; buffer: string }) {
    const [p, pred] = await Promise.all([this.priorities.priorities(org, { buffer: q.buffer, rate: '12' }), this.predictions.predictions(org)]);
    const s = minorUnits(org.functionalCurrency);
    const cash = p.accounts.reduce((t, a) => t.plus(a.balance), new D(0));
    const r = predictPaymentDates({
      bills: p.bills.map((b) => ({ id: b.id, number: b.number, vendor: b.vendor, dueDate: b.dueDate, due: b.due, score: b.score, inBatch: b.inBatch, blocked: !b.bankVerified })),
      receipts: pred.invoices.map((i) => ({ id: i.invoiceId, number: i.number ?? '', customer: i.customer, date: i.predictedPayDate, amount: i.outstanding })),
      cash: cash.toFixed(s),
      buffer: new D(q.buffer).toFixed(s),
      asOf: p.asOf,
      days: q.days,
      scale: s,
      money: (a) => formatAmountText(new D(a).toFixed(s), org.functionalCurrency),
    });
    const plans = new Map((await this.prisma.billPaymentPlan.findMany({ where: { orgId: org.id, documentId: { in: r.bills.map((b) => b.id) } }, select: { documentId: true, payDate: true } })).map((x) => [x.documentId, fromDbDate(x.payDate)]));
    return {
      asOf: p.asOf,
      days: q.days,
      currency: org.functionalCurrency,
      accounts: p.accounts,
      summary: { ...r.summary, receiptsPredicted: pred.invoices.length, applicable: r.bills.filter((b) => b.payOn && plans.get(b.id) !== b.payOn).length },
      weeks: r.weeks,
      bills: r.bills.map((b) => ({ ...b, statusLabel: PREDICTED_PAYMENT_LABEL[b.status], plannedOn: plans.get(b.id) ?? null })),
      can: { apply: hasPermission(org.role, 'purchases.manage') },
    };
  }

  /** Plan the suggested dates (all of them, or only `documentIds`) as AP-007 payment plans. */
  async apply(org: OrgContext, actor: { id: string }, q: { days: number; buffer: string; documentIds?: string[] }) {
    const r = await this.predicted(org, q);
    const want = q.documentIds ? new Set(q.documentIds) : null;
    const plans = r.bills.filter((b) => b.payOn && b.plannedOn !== b.payOn && (!want || want.has(b.id))).map((b) => ({ documentId: b.id, payDate: b.payOn! }));
    const done = await this.schedule.planMany({ id: org.id, role: org.role, functionalCurrency: org.functionalCurrency }, actor, plans, PREDICTED_PLAN_NOTE);
    return { ...done, result: await this.predicted(org, q) };
  }
}
