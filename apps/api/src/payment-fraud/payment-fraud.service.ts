import { Injectable } from '@nestjs/common';
import { addDays, D, formatAmountText, fraudLevel, FRAUD_LEVELS, minorUnits, paymentFraudIndicators, type FraudLevel, type OrgFacts, type PaymentToCheck, type VendorFacts } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, istDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

/** Recorded payments this recent are checked. */
const RECORDED_DAYS = 90;

/**
 * Payment fraud indicators (AP-028): vendor payments waiting in open payment batches, and vendor
 * payments recorded in the last 90 days, checked for warning signs (see payment-fraud.ts in the
 * engine). Read-only; amounts are in the payment's currency for batches and recorded payments.
 */
@Injectable()
export class PaymentFraudService {
  constructor(private readonly prisma: PrismaService) {}

  async report(org: OrgContext, today = todayIso()) {
    const from = addDays(today, -RECORDED_DAYS);
    const historyFrom = toDbDate(addDays(from, -365));
    const [vendors, banks, employees, payments, batches] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId: org.id, isVendor: true }, select: { id: true, name: true, createdAt: true } }),
      this.prisma.vendorBankDetails.findMany({ where: { orgId: org.id }, select: { contactId: true, accountNumber: true, changedAt: true, changedById: true, verifiedAt: true } }),
      this.prisma.employee.findMany({ where: { orgId: org.id, bankAccountNumber: { not: null } }, select: { name: true, bankAccountNumber: true } }),
      this.prisma.payment.findMany({
        where: { orgId: org.id, kind: 'PAYMENT', status: 'POSTED', date: { gte: historyFrom } },
        select: { id: true, number: true, contactId: true, date: true, amount: true, currency: true, createdById: true, allocations: { where: { removedOn: null }, select: { targetId: true } } },
      }),
      this.prisma.paymentBatch.findMany({
        where: { orgId: org.id, status: { in: ['DRAFT', 'APPROVED'] } },
        select: { id: true, number: true, status: true, paymentDate: true, currency: true, createdById: true, items: { where: { open: true }, select: { documentId: true, contactId: true, amount: true } } },
      }),
    ]);
    const vendorIds = new Set(vendors.map((v) => v.id));
    const bankOf = new Map(banks.map((b) => [b.contactId, b]));
    const nameOf = new Map(vendors.map((v) => [v.id, v.name]));

    // Candidates: one per vendor per open batch, and each recorded vendor payment in the window.
    type Candidate = PaymentToCheck & { contactId: string; source: 'BATCH' | 'PAYMENT'; ref: { id: string; label: string; status?: string }; currency: string };
    const candidates: Candidate[] = [];
    const billsInOpenBatches = new Map<string, string[]>();
    for (const b of batches) {
      const by = new Map<string, { amount: InstanceType<typeof D>; docs: string[] }>();
      for (const i of b.items) {
        const g = by.get(i.contactId) ?? { amount: new D(0), docs: [] };
        g.amount = g.amount.plus(i.amount.toString());
        g.docs.push(i.documentId);
        by.set(i.contactId, g);
      }
      for (const [contactId, g] of by) {
        const key = `batch:${b.id}:${contactId}`;
        for (const d of g.docs) billsInOpenBatches.set(d, [...(billsInOpenBatches.get(d) ?? []), key]);
        candidates.push({ key, contactId, source: 'BATCH', ref: { id: b.id, label: `Batch ${b.number}`, status: b.status }, currency: b.currency, date: fromDbDate(b.paymentDate), amount: g.amount.toFixed(), documentIds: g.docs, madeById: b.createdById });
      }
    }
    const vendorPayments = payments.filter((p) => vendorIds.has(p.contactId));
    for (const p of vendorPayments) {
      if (fromDbDate(p.date) < from) continue;
      candidates.push({ key: `payment:${p.id}`, contactId: p.contactId, source: 'PAYMENT', ref: { id: p.id, label: p.number }, currency: p.currency, date: fromDbDate(p.date), amount: p.amount.toFixed(), documentIds: [...new Set(p.allocations.map((a) => a.targetId))], madeById: p.createdById });
    }

    const orgFacts: OrgFacts = {
      vendors: vendors.map((v) => ({ contactId: v.id, name: v.name, accountNumber: bankOf.get(v.id)?.accountNumber ?? null })),
      employeeAccounts: employees.map((e) => ({ name: e.name, accountNumber: e.bankAccountNumber! })),
      billsInOpenBatches,
    };
    const facts = new Map<string, VendorFacts>();
    const factsOf = (contactId: string): VendorFacts => {
      let f = facts.get(contactId);
      if (!f) {
        const v = vendors.find((x) => x.id === contactId)!;
        const b = bankOf.get(contactId);
        f = {
          contactId,
          name: v.name,
          createdOn: istDate(v.createdAt),
          bank: b ? { accountNumber: b.accountNumber, changedOn: istDate(b.changedAt), changedById: b.changedById, verified: !!b.verifiedAt } : null,
          payments: vendorPayments.filter((p) => p.contactId === contactId).map((p) => ({ key: `payment:${p.id}`, date: fromDbDate(p.date), amount: p.amount.toFixed() })),
        };
        facts.set(contactId, f);
      }
      return f;
    };

    const rows = candidates
      .filter((c) => vendorIds.has(c.contactId))
      .map((c) => {
        const s = minorUnits(c.currency);
        const indicators = paymentFraudIndicators(c, factsOf(c.contactId), orgFacts, (x) => formatAmountText(new D(x).toFixed(s), c.currency));
        return { key: c.key, source: c.source, ref: c.ref, contactId: c.contactId, vendor: nameOf.get(c.contactId) ?? 'Unknown vendor', date: c.date, amount: new D(c.amount).toFixed(s), currency: c.currency, level: fraudLevel(indicators), indicators };
      });
    const flagged = rows
      .filter((r) => r.level)
      .sort((a, b) => FRAUD_LEVELS.indexOf(a.level!) - FRAUD_LEVELS.indexOf(b.level!) || (a.source === b.source ? 0 : a.source === 'BATCH' ? -1 : 1) || b.date.localeCompare(a.date) || a.vendor.localeCompare(b.vendor));
    const count = (l: FraudLevel) => flagged.filter((r) => r.level === l).length;
    return {
      asOf: today,
      windowDays: RECORDED_DAYS,
      summary: { checked: rows.length, flagged: flagged.length, high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'), inBatches: flagged.filter((r) => r.source === 'BATCH').length },
      payments: flagged,
    };
  }
}
