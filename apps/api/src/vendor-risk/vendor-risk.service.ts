import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  addDays,
  D,
  type Dec,
  formatAmountText,
  VENDOR_OVERDUE_DAYS,
  VENDOR_REVIEW_AFTER_DAYS,
  validateVendorRiskReview,
  VendorRiskError,
  vendorReviewNeed,
  vendorRiskFactors,
  vendorRiskLevel,
  vendorRiskRank,
  vendorSpendShare,
  type VendorRiskDecision,
  type VendorRiskLevel,
} from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { SupplierTaxService } from '../supplier-tax/supplier-tax.service';
import { todayIst } from '../tasks/tasks.service';
import { VendorPerformanceService } from '../vendor-performance/vendor-performance.service';

type Actor = { id: string };
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
/** Account number and bank code with spaces and dashes taken out, for spotting one account on two vendors. */
const accountKey = (b: { accountNumber: string; ifsc: string | null; swiftBic: string | null }) => `${b.accountNumber.replace(/[\s-]/g, '').toUpperCase()}|${(b.ifsc ?? b.swiftBic ?? '').toUpperCase()}`;

/**
 * Vendor risk monitoring (AP-024): each active vendor's risk from what the books already hold, worked
 * out by the engine's vendorRiskFactors, and people's reviews of it, which are kept for good. A
 * medium or high risk waits for a review; a new factor, a higher level or a review date reached
 * asks for another. The VENDOR_RISK alert check raises the same vendors in Alerts.
 */
@Injectable()
export class VendorRiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
    private readonly supplierTax: SupplierTaxService,
    private readonly performance: VendorPerformanceService,
  ) {}

  async report(orgId: string) {
    const today = todayIst();
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    const money = (x: string) => formatAmountText(new D(x).toFixed(2), org.functionalCurrency);
    const vendors = await this.prisma.contact.findMany({ where: { orgId, isVendor: true, isActive: true }, select: { id: true, name: true, createdAt: true }, orderBy: { name: 'asc' } });
    const ids = vendors.map((v) => v.id);
    const [perf, tax, open, banks, onboardingSetting, onboardings, reviews] = await Promise.all([
      this.performance.gradesAndSpend(orgId),
      this.supplierTax.report({ id: orgId }),
      this.subledger.openItems(this.prisma, orgId, 'PURCHASES', today),
      this.prisma.vendorBankDetails.findMany({ where: { orgId }, select: { contactId: true, accountNumber: true, ifsc: true, swiftBic: true, changedAt: true, verifiedAt: true } }),
      this.prisma.customerOnboardingSettings.findUnique({ where: { orgId_party: { orgId, party: 'VENDOR' } }, select: { required: true } }),
      this.prisma.customerOnboarding.findMany({ where: { orgId, party: 'VENDOR', contactId: { in: ids } }, select: { contactId: true, status: true } }),
      this.prisma.vendorRiskReview.findMany({ where: { orgId, contactId: { in: ids } }, orderBy: [{ reviewedOn: 'desc' }, { createdAt: 'desc' }] }),
    ]);
    const active = new Set(ids);
    const name = new Map(vendors.map((v) => [v.id, v.name]));
    const byAccount = new Map<string, string[]>();
    for (const b of banks) if (active.has(b.contactId)) byAccount.set(accountKey(b), [...(byAccount.get(accountKey(b)) ?? []), b.contactId]);
    const bankOf = new Map(banks.map((b) => [b.contactId, b]));
    const taxOf = new Map(tax.vendors.map((v) => [v.id, v]));
    const onboardingOf = new Map(onboardings.map((o) => [o.contactId, o.status]));
    const lastReview = new Map<string, (typeof reviews)[number]>();
    for (const r of reviews) if (!lastReview.has(r.contactId)) lastReview.set(r.contactId, r);
    const owed = new Map<string, Dec>();
    const overdue = new Map<string, Dec>();
    for (const i of open) {
      if (i.type !== 'charge') continue;
      owed.set(i.contactId, (owed.get(i.contactId) ?? new D(0)).plus(i.open));
      if (i.dueDate && i.dueDate < addDays(today, -VENDOR_OVERDUE_DAYS)) overdue.set(i.contactId, (overdue.get(i.contactId) ?? new D(0)).plus(i.open));
    }
    const totalSpend = [...perf.entries()].filter(([id]) => active.has(id)).reduce((s, [, p]) => s.plus(p.spend), new D(0)).toFixed(2);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(reviews.map((r) => r.reviewedById))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

    const rows = vendors.map((v) => {
      const bank = bankOf.get(v.id);
      const t = taxOf.get(v.id);
      const spend = perf.get(v.id)?.spend ?? '0';
      const factors = vendorRiskFactors(
        {
          createdOn: istDate(v.createdAt),
          spend,
          totalSpend,
          openPayable: (owed.get(v.id) ?? new D(0)).toFixed(2),
          overdue: (overdue.get(v.id) ?? new D(0)).toFixed(2),
          bank: bank ? { changedOn: istDate(bank.changedAt), verified: !!bank.verifiedAt, sameAccountAs: (byAccount.get(accountKey(bank)) ?? []).filter((id) => id !== v.id).map((id) => name.get(id)!) } : null,
          tax: { high: t?.high ?? 0, medium: t?.medium ?? 0 },
          grade: perf.get(v.id)?.grade ?? null,
          onboarding: { required: !!onboardingSetting?.required, status: onboardingOf.get(v.id) ?? null },
        },
        today,
        money,
      );
      const level = vendorRiskLevel(factors);
      const r = lastReview.get(v.id);
      const last = r ? { level: r.level as VendorRiskLevel, factorCodes: r.factorCodes, reviewedOn: fromDbDate(r.reviewedOn), nextReviewOn: fromDbDate(r.nextReviewOn) } : null;
      const { need, newFactors } = vendorReviewNeed(level, factors, last, today);
      return {
        id: v.id,
        name: v.name,
        level,
        factors,
        need,
        newFactors,
        spend,
        share: vendorSpendShare(spend, totalSpend),
        owed: (owed.get(v.id) ?? new D(0)).toFixed(2),
        lastReview: r && last ? { ...last, id: r.id, decision: r.decision as VendorRiskDecision, note: r.note, reviewedBy: users.get(r.reviewedById) ?? null } : null,
      };
    });
    rows.sort((a, b) => Number(!!b.need) - Number(!!a.need) || vendorRiskRank(b.level) - vendorRiskRank(a.level) || b.factors.length - a.factors.length || a.name.localeCompare(b.name));
    return {
      asOf: today,
      currency: org.functionalCurrency,
      totalSpend,
      totals: {
        vendors: rows.length,
        high: rows.filter((r) => r.level === 'HIGH').length,
        medium: rows.filter((r) => r.level === 'MEDIUM').length,
        low: rows.filter((r) => r.level === 'LOW').length,
        needsReview: rows.filter((r) => r.need).length,
        stopped: rows.filter((r) => r.lastReview?.decision === 'STOP').length,
      },
      vendors: rows,
      all: reviews,
      users,
    };
  }

  /** The report without the internals used to build one vendor's view. */
  async list(orgId: string) {
    const { all: _all, users: _users, ...r } = await this.report(orgId);
    return r;
  }

  async forVendor(orgId: string, contactId: string) {
    const r = await this.report(orgId);
    const v = r.vendors.find((x) => x.id === contactId);
    if (!v) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Active vendor not found' });
    const today = r.asOf;
    return {
      asOf: today,
      currency: r.currency,
      ...v,
      suggestedNextReviewOn: addDays(today, VENDOR_REVIEW_AFTER_DAYS[v.level === 'NONE' ? 'LOW' : v.level]),
      reviews: r.all
        .filter((x) => x.contactId === contactId)
        .map((x) => ({ id: x.id, level: x.level, factorCodes: x.factorCodes, decision: x.decision, note: x.note, reviewedOn: fromDbDate(x.reviewedOn), nextReviewOn: fromDbDate(x.nextReviewOn), reviewedBy: r.users.get(x.reviewedById) ?? null })),
    };
  }

  /** Records a person's review of the vendor's risk as it stands now. */
  async review(orgId: string, actor: Actor, contactId: string, input: { decision: VendorRiskDecision; note: string; reviewedOn?: string | null; nextReviewOn: string }) {
    const today = todayIst();
    const reviewedOn = input.reviewedOn ?? today;
    try {
      validateVendorRiskReview({ ...input, reviewedOn }, today);
    } catch (e) {
      if (e instanceof VendorRiskError) throw new DomainError('RISK_REVIEW_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY);
      throw e;
    }
    const now = await this.forVendor(orgId, contactId);
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.vendorRiskReview.create({
        data: {
          orgId,
          contactId,
          level: now.level,
          factorCodes: now.factors.map((f) => f.code),
          decision: input.decision,
          note: input.note.trim(),
          reviewedOn: toDbDate(reviewedOn),
          nextReviewOn: toDbDate(input.nextReviewOn),
          reviewedById: actor.id,
        },
      });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'vendor_risk.reviewed',
        entityType: 'contact',
        entityId: contactId,
        data: { reviewId: row.id, level: now.level, factors: now.factors.map((f) => f.code), decision: input.decision, reviewedOn, nextReviewOn: input.nextReviewOn },
      });
    });
    return this.forVendor(orgId, contactId);
  }
}
