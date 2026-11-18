import { HttpStatus, Injectable } from '@nestjs/common';
import { D, Dec, minorUnits } from '@talk2tax/accounting-engine';
import {
  ADVANCE_TAX_REGIME,
  ADVANCE_TAX_REGIMES,
  ADVANCE_TAX_THRESHOLD,
  advanceTaxInstalments,
  AdvanceTaxRegime,
  corporateTax,
  IncomeMethod,
  projectedIncome,
  taxYearOf,
} from '@talk2tax/tax-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AdvanceTaxPlanDoc, advanceTaxPlans } from '../db/collections/advance-tax';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { lineSums, postedBetween } from '../db/ledger-queries';

export interface PlanInput {
  regime: AdvanceTaxRegime;
  method: IncomeMethod;
  estimatedIncome: string | null;
  adjustments: { label: string; amount: string }[];
  paidAccountId: string | null;
  tdsAccountId: string | null;
  otherCredits: string;
}

const DEFAULT_PLAN: PlanInput = { regime: 'COMPANY_25', method: 'ANNUALISE', estimatedIncome: null, adjustments: [], paidAccountId: null, tdsAccountId: null, otherCredits: '0' };

/**
 * Advance tax (TAX-021). MongoDB only. The year's taxable income is the profit in the books so
 * far (income tax expense and year-end closing left out), annualised or replaced by an
 * estimate, plus the organisation's own adjustments; the tax on it less tax credits gives the
 * year's liability, and payments are the debits to the chosen advance tax account.
 * reports.read sees it, accounts.manage saves the plan.
 */
@Injectable()
export class AdvanceTaxService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async india(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'Advance tax is worked out for Indian organisations only', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private year(taxYear?: string) {
    const ty = taxYearOf(taxYear ? `${taxYear.slice(0, 4)}-04-01` : todayIso());
    if (taxYear && ty.label !== taxYear) throw new DomainError('INVALID_TAX_YEAR', 'Give the tax year as 2026-27', HttpStatus.BAD_REQUEST);
    return ty;
  }

  async get(org: OrgContext, taxYear?: string) {
    await this.india(org.id);
    const ty = this.year(taxYear);
    const scale = minorUnits(org.functionalCurrency);
    const today = todayIso();
    const asOf = today > ty.to ? ty.to : today;
    const saved = await this.store.collection(advanceTaxPlans).findOne({ taxYear: ty.label });
    const plan: PlanInput = saved
      ? { regime: saved.regime, method: saved.method, estimatedIncome: saved.estimatedIncome, adjustments: saved.adjustments, paidAccountId: saved.paidAccountId, tdsAccountId: saved.tdsAccountId, otherCredits: saved.otherCredits }
      : DEFAULT_PLAN;
    const chart = await this.store.collection(accounts).find({}, { sort: { code: 1 } });
    const byId = new Map(chart.map((a) => [a.id, a]));

    // Profit before tax so far: revenue less expenses, without income tax expense or closing entries.
    const sums = asOf < ty.from ? [] : await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(ty.from), toDbDate(asOf), { excludeClosing: true }), by: { accountId: 'lines.accountId' } });
    let profitToDate = new D(0);
    let taxExpense = new D(0);
    for (const s of sums) {
      const a = byId.get(s.key.accountId as string);
      if (!a || (a.type !== 'REVENUE' && a.type !== 'EXPENSE')) continue;
      if (a.subtype === 'TAX_EXPENSE') taxExpense = taxExpense.plus(s.debit.minus(s.credit));
      else profitToDate = profitToDate.plus(s.credit.minus(s.debit));
    }
    const projected = projectedIncome({ profitToDate, from: ty.from, to: ty.to, asOf, method: plan.method, estimate: plan.estimatedIncome });
    const adjustments = plan.adjustments.reduce((s, x) => s.plus(x.amount), new D(0));
    const tax = corporateTax(projected.amount.plus(adjustments), plan.regime);

    const movements = async (accountId: string | null) =>
      accountId
        ? (await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(ty.from), toDbDate(ty.to)), line: { accountId }, by: { date: 'date' } }))
            .map((r) => ({ date: fromDbDate(r.key.date as Date), amount: r.debit.minus(r.credit) }))
            .filter((r) => !r.amount.isZero())
            .sort((a, b) => a.date.localeCompare(b.date))
        : [];
    const [payments, tdsLines] = await Promise.all([movements(plan.paidAccountId), movements(plan.tdsAccountId)]);
    const tdsCredit = tdsLines.filter((l) => l.date <= asOf).reduce((s, l) => s.plus(l.amount), new D(0));
    const credits = tdsCredit.plus(plan.otherCredits);
    const net = D.max(tax.total.minus(credits), 0);
    const required = net.gte(ADVANCE_TAX_THRESHOLD);
    const instalments = advanceTaxInstalments(ty.from, required ? net : '0', payments, today);
    const paid = payments.filter((p) => p.date <= today).reduce((s, p) => s.plus(p.amount), new D(0));
    const who = saved ? await this.store.collection(users).findById(saved.updatedById) : null;
    const acct = (id: string | null) => (id && byId.get(id) ? { id, code: byId.get(id)!.code, name: byId.get(id)!.name } : null);
    const m = (x: Dec | string | number) => new D(x.toString()).toFixed(scale);

    return {
      taxYear: ty.label,
      from: ty.from,
      to: ty.to,
      asOf,
      currency: org.functionalCurrency,
      saved: saved ? { updatedAt: saved.updatedAt.toISOString(), updatedBy: who?.name ?? null } : null,
      plan: { ...plan, estimatedIncome: plan.estimatedIncome == null ? null : m(plan.estimatedIncome), otherCredits: m(plan.otherCredits), adjustments: plan.adjustments.map((x) => ({ label: x.label, amount: m(x.amount) })), paidAccount: acct(plan.paidAccountId), tdsAccount: acct(plan.tdsAccountId) },
      regimes: ADVANCE_TAX_REGIMES.map((k) => ({ key: k, label: ADVANCE_TAX_REGIME[k].label, note: ADVANCE_TAX_REGIME[k].note })),
      income: {
        profitToDate: m(profitToDate),
        taxExpenseExcluded: m(taxExpense),
        daysElapsed: projected.daysElapsed,
        daysInYear: projected.daysInYear,
        projected: m(projected.amount),
        adjustments: m(adjustments),
        taxable: m(tax.income),
      },
      tax: { tax: m(tax.tax), surchargeRate: tax.surchargeRate.times(100).toFixed(), surcharge: m(tax.surcharge), marginalRelief: m(tax.marginalRelief), cess: m(tax.cess), total: m(tax.total) },
      credits: { tds: m(tdsCredit), other: m(plan.otherCredits), total: m(credits) },
      netLiability: m(net),
      required,
      threshold: m(ADVANCE_TAX_THRESHOLD),
      paid: m(paid),
      remaining: m(required ? D.max(net.minus(paid), 0) : 0),
      payments: payments.map((p) => ({ date: p.date, amount: m(p.amount) })),
      instalments: instalments.map((i) => ({ number: i.number, dueDate: i.dueDate, share: i.share.times(100).toFixed(), required: m(i.required), paidByDue: m(i.paidByDue), status: i.status, toPay: m(i.toPay) })),
    };
  }

  async save(org: OrgContext, actorId: string, taxYear: string, input: PlanInput): Promise<Awaited<ReturnType<AdvanceTaxService['get']>>> {
    await this.india(org.id);
    const ty = this.year(taxYear);
    if (input.method === 'ESTIMATE' && input.estimatedIncome == null) throw new DomainError('ESTIMATE_NEEDED', 'Enter the estimated profit for the year', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.paidAccountId && input.paidAccountId === input.tdsAccountId) throw new DomainError('SAME_ACCOUNT', 'Advance tax paid and tax deducted at source need different accounts', HttpStatus.UNPROCESSABLE_ENTITY);
    for (const [id, what] of [[input.paidAccountId, 'advance tax paid'], [input.tdsAccountId, 'tax deducted at source']] as const) {
      if (!id) continue;
      const a = await this.store.collection(accounts).findById(id);
      if (!a || a.type !== 'ASSET' || !a.isPostable) throw new DomainError('INVALID_ACCOUNT', `The ${what} account must be a postable asset account`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const data = {
      regime: input.regime,
      method: input.method,
      estimatedIncome: input.method === 'ESTIMATE' ? new D(input.estimatedIncome!).toFixed() : null,
      adjustments: input.adjustments.map((x) => ({ label: x.label.trim(), amount: new D(x.amount).toFixed() })),
      paidAccountId: input.paidAccountId,
      tdsAccountId: input.tdsAccountId,
      otherCredits: new D(input.otherCredits).toFixed(),
    };
    const col = this.store.collection(advanceTaxPlans);
    const before = await col.findOne({ taxYear: ty.label });
    const now = new Date();
    let id: string;
    if (before) {
      await col.updateOne({ id: before.id }, { $set: { ...data, updatedById: actorId, updatedAt: now } });
      id = before.id;
    } else {
      try {
        id = (await col.insertOne({ orgId: org.id, taxYear: ty.label, ...data, updatedById: actorId, createdAt: now, updatedAt: now } as Omit<AdvanceTaxPlanDoc, 'id'>)).id;
      } catch (e) {
        // Saved by someone else at the same moment: save over theirs.
        if (isDuplicateKeyError(e)) return this.save(org, actorId, taxYear, input);
        throw e;
      }
    }
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId, action: 'advance_tax_plan.saved', entityType: 'advance_tax_plan', entityId: id, data: { taxYear: ty.label, from: before ? { regime: before.regime, method: before.method, estimatedIncome: before.estimatedIncome, adjustments: before.adjustments, otherCredits: before.otherCredits } : null, to: data } }),
    );
    return this.get(org, ty.label);
  }
}
