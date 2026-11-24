import { Injectable } from '@nestjs/common';
import {
  addDays,
  cashHeadroom,
  concentrationBand,
  D,
  minorUnits,
  plFigures,
  quarterChange,
  quarterlyTotals,
  rankAttentionItems,
  ROLE_DASHBOARDS,
  type AttentionItemInput,
  type DashboardRole,
} from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { CashFlowService } from '../cash-flow/cash-flow.service';
import { todayIso } from '../common/dates';
import { CompliancePredictionsService } from '../compliance/compliance-predictions.service';
import { KpisService } from '../kpis/kpis.service';
import { CollectionPrioritiesService } from '../payment-predictions/collection-priorities.service';
import { PaymentPrioritiesService } from '../payment-priorities/payment-priorities.service';
import { TaxForecastService } from '../tax-forecast/tax-forecast.service';
import { FinancialDependenciesService } from './financial-dependencies.service';
import { RiskMonitorService } from './risk-monitor.service';

type Kpis = Awaited<ReturnType<KpisService['kpis']>>;
type Kpi = Kpis['kpis'][number];
const kpi = (k: Kpi, withSeries = false) => ({
  key: k.key,
  label: k.label,
  unit: k.unit,
  better: k.better,
  formula: k.formula,
  value: k.value,
  reason: k.reason,
  previous: k.previous,
  change: k.change,
  improved: k.improved,
  target: k.target ? { comparator: k.target.comparator, target: k.target.target, status: k.target.status } : null,
  series: withSeries ? k.series : undefined,
});
const pick = (r: Kpis, keys: string[], withSeries = false) => keys.map((key) => r.kpis.find((k) => k.key === key)).filter((k): k is Kpi => !!k).map((k) => kpi(k, withSeries));
const quarterOf = (month: string) => `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`; // not money
const HORIZON = 90; // not money: days of cash forecast
const COLLECT_DAYS = 30; // not money

/**
 * Role dashboards (DASH-044 CEO, 045 CFO, 053 treasury manager, 063 financial risk officer,
 * 064 compliance officer, 066 investor or board viewer; DASH-067/068 a layout per role). Each role
 * gets its own figures from the organisation's own reports (KPIs, the cash forecast, payment and
 * collection priorities, the risk monitor, dependencies, deadline risk and the tax forecast), not
 * the same dashboard with another heading. The board view never names customers, vendors or
 * people. Read only; reports.read.
 */
@Injectable()
export class RoleDashboardsService {
  constructor(
    private readonly kpis: KpisService,
    private readonly cash: CashFlowService,
    private readonly collections: CollectionPrioritiesService,
    private readonly payments: PaymentPrioritiesService,
    private readonly risk: RiskMonitorService,
    private readonly dependencies: FinancialDependenciesService,
    private readonly deadlines: CompliancePredictionsService,
    private readonly taxes: TaxForecastService,
  ) {}

  async brief(org: OrgContext, role: DashboardRole) {
    const today = todayIso();
    const head = { role, ...ROLE_DASHBOARDS[role], asOf: today, currency: org.functionalCurrency };
    switch (role) {
      case 'CEO':
        return { ...head, ceo: await this.ceo(org, today) };
      case 'CFO':
        return { ...head, cfo: await this.cfo(org, today) };
      case 'TREASURY':
        return { ...head, treasury: await this.treasury(org, today) };
      case 'RISK':
        return { ...head, risk: await this.riskOfficer(org, today) };
      case 'COMPLIANCE':
        return { ...head, compliance: await this.compliance(org, today) };
      case 'BOARD':
        return { ...head, board: await this.board(org) };
    }
  }

  private attentionFrom(parts: {
    risk?: Awaited<ReturnType<RiskMonitorService['monitor']>>;
    collections?: Awaited<ReturnType<CollectionPrioritiesService['priorities']>>;
    payments?: Awaited<ReturnType<PaymentPrioritiesService['priorities']>>;
    deadlines?: Awaited<ReturnType<CompliancePredictionsService['predict']>>;
  }): AttentionItemInput[] {
    const out: AttentionItemInput[] = [];
    for (const a of parts.risk?.areas ?? []) for (const f of a.top.filter((t) => t.level !== 'LOW').slice(0, 1)) out.push({ area: a.name, title: f.title, detail: f.detail, level: f.level, href: a.href });
    for (const c of (parts.collections?.customers ?? []).filter((c) => c.action === 'CALL' || c.action === 'CALL_AND_HOLD').slice(0, 3))
      out.push({ area: 'Collections', title: `Call ${c.name}`, detail: `${c.toChase} ${parts.collections!.currency} to chase`, level: c.action === 'CALL_AND_HOLD' ? 'HIGH' : 'MEDIUM', href: '/sales/collection-priorities', amount: c.toChase });
    const p = parts.payments?.summary;
    if (p && new D(p.short).greaterThan(0)) out.push({ area: 'Payments', title: 'Cash does not cover the bills due', detail: `${p.short} ${parts.payments!.currency} short`, level: 'HIGH', href: '/purchases/payment-priorities', amount: p.short });
    for (const d of (parts.deadlines?.items ?? []).filter((i) => i.risk !== 'LOW').slice(0, 3)) out.push({ area: 'Compliance', title: `${d.name} · ${d.periodLabel}`, detail: d.daysLeft < 0 ? `Overdue since ${d.dueDate}` : `Due ${d.dueDate}`, level: d.risk, href: '/tax/compliance-predictions' });
    return rankAttentionItems(out, 6);
  }

  private async ceo(org: OrgContext, today: string) {
    const [k, fc, risk, collections, payments, deadlines] = await Promise.all([
      this.kpis.kpis(org.id, {}),
      this.cash.forecast(org.id, { horizonDays: HORIZON }),
      this.risk.monitor(org, today),
      this.collections.priorities(org, today),
      this.payments.priorities(org, { buffer: '0', rate: '12' }),
      this.deadlines.predict(org, 30, today),
    ]);
    return {
      month: k.month,
      inProgress: k.inProgress,
      headline: pick(k, ['revenue', 'netMargin', 'netCashFlow', 'runway']),
      revenue: k.kpis.find((x) => x.key === 'revenue')?.series ?? [],
      cash: { now: fc.opening, in90Days: fc.closing.base, lowest: fc.lowest.base },
      risk: { score: risk.score, level: risk.level, focus: risk.focus.map((a) => risk.areas.find((x) => x.area === a)!.name) },
      customers: { largestShare: k.customers.largestShare, topFiveShare: k.customers.topFiveShare, top: k.customers.top.map((c) => ({ name: c.name, revenue: c.revenue, share: c.share })) },
      attention: this.attentionFrom({ risk, collections, payments, deadlines }),
    };
  }

  private async cfo(org: OrgContext, today: string) {
    const s = minorUnits(org.functionalCurrency);
    const [k, fc, collections, payments, taxes] = await Promise.all([
      this.kpis.kpis(org.id, {}),
      this.cash.forecast(org.id, { horizonDays: HORIZON }),
      this.collections.priorities(org, today),
      this.payments.priorities(org, { buffer: '0', rate: '12' }),
      this.taxes.forecast(org, 3, today),
    ]);
    const open = (rows: { open: string }[]) => rows.reduce((t, r) => t.plus(r.open), new D(0)).toFixed(s);
    const overdue = (rows: { open: string; dueDate: string }[]) => rows.filter((r) => r.dueDate < today).reduce((t, r) => t.plus(r.open), new D(0)).toFixed(s);
    return {
      month: k.month,
      inProgress: k.inProgress,
      profitability: pick(k, ['grossMargin', 'operatingMargin', 'netMargin', 'opexRatio'], true),
      liquidity: pick(k, ['currentRatio', 'quickRatio', 'workingCapital', 'debtToEquity']),
      efficiency: pick(k, ['dso', 'dpo']),
      workingCapital: {
        receivables: { open: open(fc.receivables), overdue: overdue(fc.receivables), invoices: fc.receivables.length, toChase: collections.summary.toChase, disputed: collections.summary.disputed },
        payables: { open: open(fc.payables), overdue: overdue(fc.payables), bills: fc.payables.length, payNow: payments.summary.payNow, short: payments.summary.short, offerSavings: payments.summary.offerSavings },
      },
      tax: { months: taxes.months, totals: taxes.totals, overdue: taxes.overdue },
    };
  }

  private async treasury(org: OrgContext, today: string) {
    const s = minorUnits(org.functionalCurrency);
    const [fc, payments] = await Promise.all([this.cash.forecast(org.id, { horizonDays: HORIZON }), this.payments.priorities(org, { buffer: '0', rate: '12' })]);
    const until = addDays(today, COLLECT_DAYS);
    const coming = fc.receivables.filter((r) => !r.doubtful && r.expected.base <= until);
    return {
      accounts: fc.cashAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: a.balance })),
      forecast: {
        horizonDays: HORIZON,
        opening: fc.opening,
        closing: fc.closing,
        lowest: fc.lowest,
        minimumBalance: fc.minimumBalance,
        belowBuffer: fc.belowBuffer,
        headroom: cashHeadroom({ asOf: fc.start, lowest: fc.lowest.base, buffer: fc.minimumBalance, scale: s }),
        buckets: fc.buckets.map((b) => ({ from: b.from, to: b.to, inflow: new D(b.inflows.RECEIVABLE).plus(b.inflows.PLANNED_IN).toFixed(s), outflow: new D(b.outflows.PAYABLE).plus(b.outflows.PLANNED_OUT).toFixed(s), closing: b.closing, low: b.low, high: b.high })),
      },
      payments: {
        summary: payments.summary,
        bills: payments.bills.slice(0, 8).map((b) => ({ id: b.id, vendor: b.vendor, number: b.number, dueDate: b.dueDate, due: b.due, action: b.action, actionLabel: b.actionLabel })),
      },
      collections: {
        days: COLLECT_DAYS,
        expected: coming.reduce((t, r) => t.plus(r.open), new D(0)).toFixed(s),
        invoices: coming.slice(0, 8).map((r) => ({ id: r.id, customer: r.contactName, number: r.number, expectedOn: r.expected.base, open: r.open })),
        count: coming.length,
      },
    };
  }

  private async riskOfficer(org: OrgContext, today: string) {
    const [risk, deps] = await Promise.all([this.risk.monitor(org, today), this.dependencies.dependencies(org, {})]);
    const groups = Object.values(deps.groups).map((g) => ({ group: g.group, count: g.count, total: g.total, hhi: g.hhi, concentration: g.concentration, largestShare: g.largestShare }));
    return {
      score: risk.score,
      level: risk.level,
      complete: risk.complete,
      previous: risk.previous,
      areas: risk.areas.map((a) => ({ area: a.area, name: a.name, href: a.href, score: a.score, level: a.level, high: a.high, medium: a.medium, low: a.low, available: a.available, active: a.active })),
      history: risk.history.map((h) => ({ date: h.date, score: h.score })),
      groups,
      dependencies: deps.dependencies.slice(0, 8).map((d) => ({ group: d.group, name: d.name, share: d.share, severity: d.severity, reason: d.reason })),
      attention: this.attentionFrom({ risk }),
      dependencyPeriod: { from: deps.from, to: deps.to },
    };
  }

  private async compliance(org: OrgContext, today: string) {
    const [p, t] = await Promise.all([this.deadlines.predict(org, 60, today), this.taxes.forecast(org, 3, today)]);
    const items = p.items.map((i) => ({ key: i.key, name: i.name, periodLabel: i.periodLabel, dueDate: i.dueDate, daysLeft: i.daysLeft, risk: i.risk, lateRate: i.lateRate, predictedDate: i.predictedDate, reasons: i.reasons }));
    return {
      configured: p.configured,
      days: p.days,
      summary: { ...p.summary, overdue: items.filter((i) => i.daysLeft < 0).length, dueThisWeek: items.filter((i) => i.daysLeft >= 0 && i.daysLeft <= 7).length },
      next: items.find((i) => i.daysLeft >= 0) ?? null,
      deadlines: items,
      tax: { months: t.months, totals: t.totals, items: t.items.map((i) => ({ key: i.key, name: i.name, periodLabel: i.periodLabel, dueDate: i.dueDate, method: i.method, amount: i.amount })) },
    };
  }

  private async board(org: OrgContext) {
    const s = minorUnits(org.functionalCurrency);
    const k = await this.kpis.kpis(org.id, {});
    const figures = await this.kpis.monthFigures(org.id, k.month, k.to, 12);
    const monthly = figures.map((m) => ({ month: m.month, pl: plFigures(m), cash: m.cash }));
    const revenue = quarterlyTotals(monthly.map((m) => ({ month: m.month, value: m.pl.operatingRevenue.toFixed() })), s);
    const net = quarterlyTotals(monthly.map((m) => ({ month: m.month, value: m.pl.netIncome.toFixed() })), s);
    const gross = quarterlyTotals(monthly.map((m) => ({ month: m.month, value: m.pl.grossProfit.toFixed() })), s);
    const quarters = revenue.map((q, i) => {
      const lastMonth = monthly.filter((m) => quarterOf(m.month) === q.quarter).at(-1)!;
      return {
        quarter: q.quarter,
        months: q.months,
        revenue: q.value ?? new D(0).toFixed(s),
        grossProfit: gross[i]!.value ?? new D(0).toFixed(s),
        netIncome: net[i]!.value ?? new D(0).toFixed(s),
        closingCash: lastMonth.cash.toFixed(s),
        revenueGrowth: i > 0 ? quarterChange(revenue[i - 1]!.value, q.value) : null,
      };
    });
    return {
      month: k.month,
      inProgress: k.inProgress,
      quarters,
      position: pick(k, ['grossMargin', 'netMargin', 'currentRatio', 'debtToEquity', 'runway']),
      // Concentration only as shares and a band: a board pack never names customers.
      concentration: { band: concentrationBand(k.customers.largestShare), largestShare: k.customers.largestShare, topFiveShare: k.customers.topFiveShare, customers: k.customers.top.length + k.customers.others.count },
    };
  }
}
