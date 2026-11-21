import { Injectable } from '@nestjs/common';
import { D, dec, minorUnits, PAYMENT_ACTION_LABEL, prioritisePayments, vendorSpendShare } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { BankingService } from '../banking/banking.service';
import { PaymentBatchesService } from '../payment-batches/payment-batches.service';
import { todayIst } from '../tasks/tasks.service';
import { VendorPerformanceService } from '../vendor-performance/vendor-performance.service';

/**
 * Intelligent payment prioritisation (AP-030) and dynamic discount recommendations (AP-029): open
 * bills in the functional currency ranked against the cash in the bank accounts, with early-payment
 * discount offers when the cash covers everything. Read-only: nothing is paid or planned here.
 */
@Injectable()
export class PaymentPrioritiesService {
  constructor(
    private readonly batches: PaymentBatchesService,
    private readonly banking: BankingService,
    private readonly performance: VendorPerformanceService,
  ) {}

  async priorities(org: OrgContext, q: { buffer: string; rate: string }) {
    const today = todayIst();
    const s = minorUnits(org.functionalCurrency);
    const [bills, accounts, spend] = await Promise.all([this.batches.payableBills(org), this.banking.listAccounts(org), this.performance.gradesAndSpend(org.id)]);
    const active = accounts.filter((a) => a.isActive);
    const cash = active.reduce((t, a) => t.plus(dec(a.ledgerBalance)), dec('0'));
    const totalSpend = [...spend.values()].reduce((t, v) => t.plus(v.spend), new D(0)).toFixed();
    const r = prioritisePayments({
      bills: bills.map((b) => ({
        id: b.id,
        number: b.number ?? '',
        vendorId: b.vendor.id,
        vendor: b.vendor.name,
        issueDate: b.issueDate,
        dueDate: b.dueDate ?? b.issueDate,
        due: b.due,
        inBatch: b.inBatch,
        bankVerified: !!b.bank?.verified,
        spendShare: spend.has(b.vendor.id) ? vendorSpendShare(spend.get(b.vendor.id)!.spend, totalSpend) : null,
      })),
      cash: cash.toFixed(s),
      buffer: q.buffer,
      annualRatePercent: q.rate,
      asOf: today,
      minorUnits: s,
    });
    return {
      asOf: today,
      currency: org.functionalCurrency,
      rate: new D(q.rate).toFixed(),
      accounts: active.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: a.ledgerBalance })),
      summary: r.summary,
      bills: r.bills.map((b) => ({ ...b, actionLabel: PAYMENT_ACTION_LABEL[b.action] })),
    };
  }
}
