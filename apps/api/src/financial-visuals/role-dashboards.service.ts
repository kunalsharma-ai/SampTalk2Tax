import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  addDays,
  agingByDueDate,
  biggestMovements,
  cashHeadroom,
  concentrationBand,
  D,
  minorUnits,
  plFigures,
  quarterChange,
  quarterlyTotals,
  rankAttentionItems,
  sharePercent,
  ROLE_DASHBOARDS,
  type AttentionItemInput,
  type DashboardRole,
} from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { AiControlService } from '../ai-control/ai-control.service';
import { AiDecisionsService } from '../ai-decisions/ai-decisions.service';
import { PayrollService } from '../payroll/payroll.service';
import { PayrollReportService } from '../payroll-report/payroll-report.service';
import { AuditEngagementsService } from '../audit-engagements/audit-engagements.service';
import { AuditEvidenceService } from '../audit-evidence/audit-evidence.service';
import { AuditFindingsService } from '../audit-findings/audit-findings.service';
import { ReconciliationExceptionsService } from '../bank-activity/reconciliation-exceptions.service';
import { CloseService } from '../close/close.service';
import { DocumentStoreService } from '../common/document-store.service';
import { journalEntries } from '../db/collections/ledger';
import { InternalControlsService } from '../internal-controls/internal-controls.service';
import { JournalApprovalsService } from '../journal-approvals/journal-approvals.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { SegregationOfDutiesService } from '../segregation-of-duties/segregation-of-duties.service';
import { VendorContractsService } from '../vendor-contracts/vendor-contracts.service';
import { VendorRiskService } from '../vendor-risk/vendor-risk.service';
import { CashFlowService } from '../cash-flow/cash-flow.service';
import { fromDbDate, istDate, todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { CompliancePredictionsService } from '../compliance/compliance-predictions.service';
import { DepartmentBudgetsService } from '../department-budgets/department-budgets.service';
import { ExpenseReceiptsService } from '../expense-receipts/expense-receipts.service';
import { ExpenseRiskService } from '../expense-risk/expense-risk.service';
import { GstReconciliationService } from '../gst/gst-reconciliation.service';
import { PaymentFraudService } from '../payment-fraud/payment-fraud.service';
import { PaymentPredictionsService } from '../payment-predictions/payment-predictions.service';
import { BillExceptionsService } from '../purchase-orders/bill-exceptions.service';
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
    private readonly prisma: PrismaService,
    private readonly predictions: PaymentPredictionsService,
    private readonly billExceptions: BillExceptionsService,
    private readonly fraud: PaymentFraudService,
    private readonly gstRecon: GstReconciliationService,
    private readonly expenseRisk: ExpenseRiskService,
    private readonly receipts: ExpenseReceiptsService,
    private readonly budgets: DepartmentBudgetsService,
    private readonly store: DocumentStoreService,
    private readonly recon: ReconciliationExceptionsService,
    private readonly close: CloseService,
    private readonly journalApprovals: JournalApprovalsService,
    private readonly sod: SegregationOfDutiesService,
    private readonly controls: InternalControlsService,
    private readonly findings: AuditFindingsService,
    private readonly engagements: AuditEngagementsService,
    private readonly evidence: AuditEvidenceService,
    private readonly orders: PurchaseOrdersService,
    private readonly contracts: VendorContractsService,
    private readonly vendorRisk: VendorRiskService,
    private readonly payroll: PayrollService,
    private readonly payrollReport: PayrollReportService,
    private readonly ai: AiControlService,
    private readonly aiDecisions: AiDecisionsService,
  ) {}

  /** Dashboards that show more than reports: each needs its own permission as well as reports.read. */
  static readonly EXTRA: Partial<Record<DashboardRole, { permission: Permission; what: string }>> = {
    EXPENSE_MANAGER: { permission: 'expenses.read', what: 'expenses' },
    CONTROLLER: { permission: 'audit.read', what: 'audit and controls' },
    INTERNAL_AUDITOR: { permission: 'audit.read', what: 'audit and controls' },
    PROCUREMENT: { permission: 'purchases.read', what: 'purchases' },
    PAYROLL_MANAGER: { permission: 'payroll.read', what: 'payroll' },
    AI_ADMIN: { permission: 'audit.read', what: 'audit and AI controls' },
  };

  /** Whether the member's role may open a dashboard. */
  static available(org: Pick<OrgContext, 'role'>, role: DashboardRole) {
    const extra = RoleDashboardsService.EXTRA[role];
    return !extra || hasPermission(org.role, extra.permission);
  }

  async brief(org: OrgContext, user: AuthUser, role: DashboardRole) {
    const today = todayIso();
    const extra = RoleDashboardsService.EXTRA[role];
    if (extra && !hasPermission(org.role, extra.permission)) throw new ForbiddenException({ error: 'FORBIDDEN', message: `This dashboard needs access to ${extra.what}` });
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
      case 'AR_MANAGER':
        return { ...head, receivables: await this.receivablesManager(org, today) };
      case 'AP_MANAGER':
        return { ...head, payables: await this.payablesManager(org, today) };
      case 'TAX_MANAGER':
        return { ...head, tax: await this.taxManager(org, today) };
      case 'EXPENSE_MANAGER':
        return { ...head, expenses: await this.expenseManager(org, today) };
      case 'ACCOUNTANT':
        return { ...head, accountant: await this.accountant(org, user, today) };
      case 'CONTROLLER':
        return { ...head, controller: await this.controller(org, user, today) };
      case 'INTERNAL_AUDITOR':
        return { ...head, audit: await this.internalAuditor(org, user, today) };
      case 'PROCUREMENT':
        return { ...head, procurement: await this.procurement(org, today) };
      case 'PAYROLL_MANAGER':
        return { ...head, payroll: await this.payrollManager(org, today) };
      case 'AI_ADMIN':
        return { ...head, ai: await this.aiAdmin(org) };
      case 'ANALYST':
        return { ...head, analyst: await this.analyst(org) };
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

  private async receivablesManager(org: OrgContext, today: string) {
    const s = minorUnits(org.functionalCurrency);
    const [k, fc, collections, forecast] = await Promise.all([
      this.kpis.kpis(org.id, {}),
      this.cash.forecast(org.id, { horizonDays: 30 }),
      this.collections.priorities(org, today),
      this.predictions.forecast(org, { weeks: 8 }, today),
    ]);
    const open = fc.receivables.map((r) => ({ open: r.open, dueDate: r.dueDate }));
    // Everyone with an overdue balance, whether or not there is enough payment history to score them.
    const late = new Map<string, { contactId: string; name: string; overdue: InstanceType<typeof D>; invoices: number; oldestDue: string }>();
    for (const r of fc.receivables.filter((x) => x.dueDate < today)) {
      const row = late.get(r.contactId) ?? { contactId: r.contactId, name: r.contactName, overdue: new D(0), invoices: 0, oldestDue: r.dueDate };
      row.overdue = row.overdue.plus(r.open);
      row.invoices += 1; // not money
      if (r.dueDate < row.oldestDue) row.oldestDue = r.dueDate;
      late.set(r.contactId, row);
    }
    const daysLate = (due: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000); // not money
    return {
      month: k.month,
      dso: pick(k, ['dso'])[0] ?? null,
      aging: agingByDueDate(open, today, s),
      doubtful: { count: fc.receivables.filter((r) => r.doubtful).length },
      overdueCustomers: [...late.values()]
        .sort((a, b) => b.overdue.comparedTo(a.overdue) || a.name.localeCompare(b.name))
        .slice(0, 10)
        .map((x) => ({ contactId: x.contactId, name: x.name, overdue: x.overdue.toFixed(s), invoices: x.invoices, oldestDaysLate: daysLate(x.oldestDue) })),
      collections: {
        summary: collections.summary,
        customers: collections.customers.slice(0, 10).map((c) => ({ contactId: c.contactId, name: c.name, open: c.open, overdue: c.overdue, disputed: c.disputed, toChase: c.toChase, oldestOverdueDays: c.oldestOverdueDays, overdueInvoices: c.overdueInvoices, action: c.action, actionLabel: c.actionLabel, lastReminderOn: c.lastReminderOn })),
      },
      forecast: { weeks: forecast.weeks, later: forecast.later, doubtful: forecast.doubtful, total: forecast.total, inHorizon: forecast.inHorizon },
    };
  }

  private async payablesManager(org: OrgContext, today: string) {
    const s = minorUnits(org.functionalCurrency);
    const [k, fc, payments, held, fraud] = await Promise.all([
      this.kpis.kpis(org.id, {}),
      this.cash.forecast(org.id, { horizonDays: 30 }),
      this.payments.priorities(org, { buffer: '0', rate: '12' }),
      this.billExceptions.list(org),
      this.fraud.report(org, today),
    ]);
    return {
      month: k.month,
      dpo: pick(k, ['dpo'])[0] ?? null,
      aging: agingByDueDate(fc.payables.map((r) => ({ open: r.open, dueDate: r.dueDate })), today, s),
      payments: {
        summary: payments.summary,
        bills: payments.bills.slice(0, 10).map((b) => ({ id: b.id, vendor: b.vendor, number: b.number, dueDate: b.dueDate, due: b.due, action: b.action, actionLabel: b.actionLabel })),
      },
      exceptions: {
        summary: { bills: held.summary.bills, atStake: held.summary.atStake, withVendor: held.summary.withVendor, awaitingGoods: held.summary.awaitingGoods, oldestDays: held.summary.oldestDays },
        items: held.items.slice(0, 5).map((i) => ({ id: i.id, vendor: i.vendor.name, reference: i.reference, order: i.order.reference, atStake: i.atStakeBase, daysHeld: i.daysHeld, nextActionLabel: i.nextActionLabel })),
      },
      fraud: {
        windowDays: fraud.windowDays,
        summary: fraud.summary,
        payments: fraud.payments.slice(0, 5).map((p) => ({ vendor: p.vendor, date: p.date, amount: p.amount, currency: p.currency, level: p.level })),
      },
    };
  }

  private async taxManager(org: OrgContext, today: string) {
    const lastMonth = (() => {
      const [y, m] = today.split('-').map(Number) as [number, number];
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    })();
    const [t, p, gst] = await Promise.all([
      this.taxes.forecast(org, 3, today),
      this.deadlines.predict(org, 60, today),
      // Not every organisation is GST-registered: then there is nothing to reconcile.
      this.gstRecon.month(org, lastMonth).catch(() => null),
    ]);
    const byArea = new Map<string, { area: string; amount: InstanceType<typeof D>; payments: number }>();
    for (const i of t.items) {
      const row = byArea.get(i.area) ?? { area: i.area, amount: new D(0), payments: 0 };
      row.amount = row.amount.plus(i.amount);
      row.payments += 1; // not money
      byArea.set(i.area, row);
    }
    const s = minorUnits(org.functionalCurrency);
    return {
      configured: t.configured,
      payments: { totals: t.totals, overdue: t.overdue, items: t.items.map((i) => ({ key: i.key, name: i.name, area: i.area, periodLabel: i.periodLabel, dueDate: i.dueDate, method: i.method, amount: i.amount, low: i.low, high: i.high })) },
      byArea: [...byArea.values()].sort((a, b) => b.amount.comparedTo(a.amount) || a.area.localeCompare(b.area)).map((a) => ({ area: a.area, amount: a.amount.toFixed(s), payments: a.payments })),
      returns: p.items.map((i) => ({ key: i.key, name: i.name, periodLabel: i.periodLabel, dueDate: i.dueDate, daysLeft: i.daysLeft, risk: i.risk, predictedDate: i.predictedDate, signals: i.signals.map((x) => x.message) })),
      gst: gst
        ? { registered: true as const, period: gst.period, agrees: gst.agrees, difference: gst.difference, unexplained: gst.unexplained, documentsChecked: gst.documentsChecked, discrepancies: gst.discrepancyCounts, items: gst.items.length }
        : { registered: false as const, period: lastMonth },
    };
  }

  private async expenseManager(org: OrgContext, today: string) {
    const [waiting, risk, missing, budgets] = await Promise.all([
      this.prisma.expenseClaim.findMany({ where: { orgId: org.id, status: 'SUBMITTED' }, orderBy: { submittedAt: 'asc' }, select: { id: true, number: true, title: true, currency: true, total: true, submittedAt: true, claimantId: true } }),
      this.expenseRisk.findings(org, { days: 90 }, today),
      this.receipts.missing(org, 30, today),
      this.budgets.report(org, undefined, today),
    ]);
    const people = waiting.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(waiting.map((w) => w.claimantId))] } }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((u) => [u.id, u.name]));
    const totals = new Map<string, InstanceType<typeof D>>();
    for (const w of waiting) totals.set(w.currency, (totals.get(w.currency) ?? new D(0)).plus(w.total.toString()));
    return {
      approvals: {
        count: waiting.length,
        totals: [...totals].sort((a, b) => a[0].localeCompare(b[0])).map(([currency, amount]) => ({ currency, amount: amount.toFixed(minorUnits(currency)) })),
        oldestDays: waiting.length && waiting[0]!.submittedAt ? Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${istDate(waiting[0]!.submittedAt)}T00:00:00Z`)) / 86_400_000)) : 0, // not money: days
        claims: waiting.slice(0, 8).map((w) => ({ id: w.id, number: w.number, title: w.title, claimant: nameOf.get(w.claimantId) ?? '', currency: w.currency, total: new D(w.total.toString()).toFixed(minorUnits(w.currency)), submittedOn: w.submittedAt ? istDate(w.submittedAt) : null })),
      },
      risk: { summary: risk.summary, items: risk.items.slice(0, 5).map((i) => ({ claimId: i.claim.id, title: i.claim.title, claimant: i.claim.claimantName, total: i.claim.total, currency: i.claim.currency, level: i.level, indicators: i.indicators.map((x) => x.detail) })) },
      receipts: { days: missing.days, lines: missing.lines, withReceipt: missing.withReceipt, missing: missing.items.length, totals: missing.totals },
      budgets: { fiscalYear: budgets.fiscalYear, totals: budgets.totals, rows: budgets.rows.map((r) => ({ departmentId: r.departmentId, name: r.name, budget: r.budget, actual: r.actual, committed: r.committed, status: r.status, usedPercent: r.usedPercent, reason: r.reason })) },
    };
  }

  /** Close status of the months up to today, newest first. */
  private async closes(org: OrgContext, months: number) {
    const l = await this.close.list(org);
    return l.periods.slice(0, months).map((p) => ({ id: p.id, name: p.name, startDate: p.startDate, endDate: p.endDate, periodStatus: p.periodStatus, closeStatus: p.closeStatus, closedBy: p.closedBy, closedAt: p.closedAt, current: p.current }));
  }

  private async pendingApprovals(org: OrgContext, user: AuthUser) {
    const rows = await this.journalApprovals.list(org, user.id, 'PENDING');
    return { count: rows.length, mine: rows.filter((r) => r.canDecide).length, items: rows.slice(0, 8).map((r) => ({ id: r.id, entryId: r.entryId, date: r.date, memo: r.memo, total: r.total, requestedBy: r.requestedBy, requestedAt: r.requestedAt, canDecide: r.canDecide })) };
  }

  private async accountant(org: OrgContext, user: AuthUser, today: string) {
    const [drafts, documents, approvals, recon, closes] = await Promise.all([
      this.store.collection(journalEntries).find({ status: 'DRAFT' }, { sort: { date: 1 }, projection: { id: 1, date: 1, memo: 1, entryNumber: 1, createdAt: 1 } }),
      this.prisma.document.findMany({ where: { orgId: org.id, status: 'DRAFT' }, select: { kind: true, issueDate: true } }),
      this.pendingApprovals(org, user),
      this.recon.analyse(org, {}, today),
      this.closes(org, 3),
    ]);
    const kinds = new Map<string, number>();
    for (const d of documents) kinds.set(d.kind, (kinds.get(d.kind) ?? 0) + 1);
    return {
      queue: {
        draftJournals: drafts.length,
        draftDocuments: documents.length,
        approvals: approvals.count,
        reconciliation: recon.summary.needsAction,
      },
      draftJournals: drafts.slice(0, 8).map((e) => ({ id: e.id, date: istDate(e.date), memo: e.memo ?? null })),
      draftDocuments: [...kinds].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, count]) => ({ kind, count })),
      approvals,
      reconciliation: {
        summary: recon.summary,
        accounts: recon.accounts.slice(0, 6).map((a) => ({ id: a.account.id, code: a.account.code, name: a.account.name, lastReconciled: a.lastReconciled, exceptions: a.exceptions.length, unmatchedStatement: a.unmatched.statement, unmatchedBook: a.unmatched.book })),
      },
      close: closes,
    };
  }

  private async controller(org: OrgContext, user: AuthUser, today: string) {
    const [closes, approvals, sod, controls, findings] = await Promise.all([
      this.closes(org, 6),
      this.pendingApprovals(org, user),
      this.sod.overview(org, user, {}),
      this.controls.list(org, user),
      this.findings.list(org, user, {}),
    ]);
    const openSod = sod.findings.filter((f) => !f.review);
    return {
      closes,
      lateCloses: closes.filter((c) => !c.current && c.closeStatus !== 'CLOSED').length,
      approvals,
      separation: {
        from: sod.from,
        to: sod.to,
        open: openSod.length,
        reviewed: sod.findings.length - openSod.length,
        rules: sod.rules.map((r) => ({ id: r.id, title: r.title, open: r.open, reviewed: r.reviewed })),
        membersWithConflicts: sod.members.filter((m) => m.conflicts.length).length,
      },
      controls: {
        summary: controls.summary,
        total: controls.controls.length,
        attention: controls.controls.filter((c) => c.status === 'FAILED' || c.status === 'OVERDUE').slice(0, 8).map((c) => ({ id: c.id, title: c.title, area: c.area, status: c.status, owner: c.owner.name, period: c.duePeriod.label })),
      },
      findings: findings.summary,
      asOf: today,
    };
  }

  private async internalAuditor(org: OrgContext, user: AuthUser, today: string) {
    const [engagements, findings, evidence, controls] = await Promise.all([this.engagements.list(user), this.findings.list(org, user, {}), this.evidence.list(user, {}), this.controls.list(org, user)]);
    return {
      asOf: today,
      engagements: engagements.engagements.filter((e) => e.status !== 'CLOSED').slice(0, 8).map((e) => ({ id: e.id, reference: e.reference, name: e.name, status: e.status, scopeFrom: e.scopeFrom, scopeTo: e.scopeTo, lead: e.lead.name, progress: e.progress, mine: e.mine })),
      engagementCount: engagements.engagements.length,
      findings: {
        summary: findings.summary,
        open: findings.findings.filter((f) => f.status !== 'CLOSED').slice(0, 10).map((f) => ({ id: f.id, reference: f.reference, title: f.title, severity: f.severity, status: f.status, dueDate: f.dueDate, overdue: f.overdue })),
      },
      evidence: {
        summary: evidence.summary,
        outstanding: evidence.requests.filter((r) => r.status !== 'ACCEPTED').slice(0, 8).map((r) => ({ id: r.id, reference: r.reference, title: r.title, status: r.status, dueDate: r.dueDate })),
      },
      controls: { summary: controls.summary, total: controls.controls.length, failed: controls.controls.filter((c) => c.status === 'FAILED').map((c) => ({ id: c.id, title: c.title, owner: c.owner.name, lastTest: c.lastTest ? { result: c.lastTest.result, testedAt: c.lastTest.testedAt } : null })) },
    };
  }

  private async procurement(org: OrgContext, today: string) {
    const until = addDays(today, 60);
    const [po, contracts, risk, held] = await Promise.all([this.orders.list(org, { view: 'open' }), this.contracts.list(org, today), this.vendorRisk.list(org.id), this.billExceptions.list(org)]);
    return {
      orders: {
        totals: po.totals,
        late: po.orders.filter((o) => o.late).slice(0, 8).map((o) => ({ id: o.id, reference: o.reference, vendor: o.contact?.name ?? '', expectedDate: o.expectedDate, toReceive: o.toReceive, total: o.total })),
        open: po.orders.slice(0, 8).map((o) => ({ id: o.id, reference: o.reference, vendor: o.contact?.name ?? '', state: o.state, orderDate: o.orderDate, expectedDate: o.expectedDate, toReceive: o.toReceive, toBill: o.toBill, total: o.total, late: o.late })),
      },
      contracts: {
        summary: contracts.summary,
        ending: contracts.contracts.filter((c) => c.state === 'IN_FORCE' && c.endDate && c.endDate <= until).map((c) => ({ id: c.id, reference: c.reference, vendor: c.vendor, title: c.title, endDate: c.endDate })),
        issues: contracts.issues.slice(0, 6).map((i) => ({ contract: i.contract.reference, vendor: i.vendor, severity: i.severity, date: i.date, billNumber: i.billNumber, detail: i.detail })),
      },
      vendors: { totals: risk.totals, risky: risk.vendors.filter((v) => v.level === 'HIGH' || v.level === 'MEDIUM').slice(0, 8).map((v) => ({ id: v.id, name: v.name, level: v.level, factors: v.factors.map((f) => f.title) })) },
      heldBills: { bills: held.summary.bills, atStake: held.summary.atStake },
    };
  }

  /** Payroll manager: this month's run, the team, what payroll costs month by month, and dues not yet paid. */
  private async payrollManager(org: OrgContext, today: string) {
    const month = today.slice(0, 7);
    const from = `${addDays(`${month}-01`, -320).slice(0, 7)}`; // about eleven months back
    const [runs, people, report] = await Promise.all([
      this.payroll.listRuns(org),
      this.prisma.employee.findMany({ where: { orgId: org.id }, select: { id: true, code: true, name: true, dateOfJoining: true, dateOfLeaving: true }, orderBy: { code: 'asc' } }),
      this.payrollReport.report(org, { from, to: month }),
    ]);
    const day = (d: Date | null) => (d ? fromDbDate(d) : null);
    const staff = people.map((e) => ({ id: e.id, code: e.code, name: e.name, joined: day(e.dateOfJoining)!, left: day(e.dateOfLeaving) }));
    const active = staff.filter((e) => e.joined <= today && (!e.left || e.left >= today));
    const live = runs.filter((r) => r.status !== 'VOID');
    // Dues of recent posted runs that are not paid yet.
    const posted = live.filter((r) => r.status === 'POSTED').slice(0, 6);
    const details = await Promise.all(posted.map((r) => this.payroll.getRun(org, r.id)));
    const unpaid = details
      .flatMap((r) => r.liabilities.filter((l) => !l.payment && new D(l.amount).greaterThan(0)).map((l) => ({ runId: r.id, number: r.number, period: r.period, liability: l.liability, label: l.label, amount: l.amount, dueDate: l.dueDate ?? null, overdue: !!l.dueDate && l.dueDate < today })))
      .sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.number.localeCompare(b.number));
    const drafts = await Promise.all(live.filter((r) => r.status === 'DRAFT').slice(0, 3).map((r) => this.payroll.getRun(org, r.id)));
    const current = live.find((r) => r.period === month) ?? null;
    return {
      month,
      thisMonth: current ? { id: current.id, number: current.number, status: current.status, payDate: current.payDate, employees: current.employees, gross: current.gross, net: current.net, employerCost: current.employerCost } : null,
      team: {
        active: active.length,
        joining: staff.filter((e) => e.joined > today).map((e) => ({ id: e.id, name: e.name, date: e.joined })),
        joinedThisMonth: staff.filter((e) => e.joined.slice(0, 7) === month && e.joined <= today).map((e) => ({ id: e.id, name: e.name, date: e.joined })),
        leavingThisMonth: staff.filter((e) => e.left && e.left.slice(0, 7) === month).map((e) => ({ id: e.id, name: e.name, date: e.left! })),
      },
      runs: live.slice(0, 6).map((r) => ({ id: r.id, number: r.number, period: r.period, status: r.status, payDate: r.payDate, employees: r.employees, gross: r.gross, net: r.net, employerCost: r.employerCost })),
      drafts: drafts.map((r) => ({ id: r.id, number: r.number, period: r.period, missing: r.missing.length })),
      unpaid: { items: unpaid.slice(0, 10), total: unpaid.reduce((t, u) => t.plus(u.amount), new D(0)).toFixed(2), overdue: unpaid.filter((u) => u.overdue).length },
      cost: { from: report.from, to: report.to, totals: report.totals, statutory: report.statutory, byMonth: report.byMonth.map((m) => ({ period: m.period, employees: m.employees, gross: m.gross, net: m.net, employerCost: m.employerCost, grossChange: m.grossChange, flagged: m.flagged })) },
    };
  }

  /** AI agent administrator: which agents are on, their use, cost and acceptance, and recent failures. */
  private async aiAdmin(org: OrgContext) {
    const [o, failed] = await Promise.all([this.ai.overview({ orgId: org.id, role: org.role }), this.aiDecisions.list({ outcome: 'FAILED', limit: 6 })]);
    const near = (p: number | null) => p !== null && p >= 80; // not money: percent of the token budget
    return {
      month: o.month,
      accuracyDays: o.accuracyDays,
      configured: o.configured,
      provider: o.provider,
      model: o.model,
      enabled: o.enabled,
      stopped: o.stopped,
      offReason: o.offReason,
      platformStopped: !!o.platformShutdown,
      totals: o.totals,
      currency: o.currency,
      agents: o.agents.map((a) => ({
        key: a.key,
        name: a.name,
        levelLabel: a.levelLabel,
        enabled: a.enabled,
        link: a.link,
        calls: a.usage.calls,
        tokens: a.usage.tokens,
        failed: a.usage.failed,
        monthlyTokenLimit: a.monthlyTokenLimit,
        percentOfBudget: a.usage.percentOfBudget,
        budgetReached: a.budgetReached,
        nearBudget: near(a.usage.percentOfBudget),
        cost: a.cost.amount,
        unpricedTokens: a.cost.unpricedTokens,
        accuracy: a.accuracy,
        running: a.running,
        lastUsedAt: a.lastUsedAt,
      })),
      failures: failed.records.map((r) => ({ id: r.id, agent: r.agent.name, startedAt: r.startedAt, errorName: r.errorName, stopReason: r.stopReason, model: r.servedModel ?? r.modelRequested })),
    };
  }

  /** Financial analyst: every key figure with its trend, the biggest moves, monthly profit and margins, and quarters. */
  private async analyst(org: OrgContext) {
    const s = minorUnits(org.functionalCurrency);
    const k = await this.kpis.kpis(org.id, {});
    const figures = await this.kpis.monthFigures(org.id, k.month, k.to, 12);
    const monthly = figures.map((m) => {
      const pl = plFigures(m);
      const revenue = pl.operatingRevenue.toFixed(s);
      return {
        month: m.month,
        revenue,
        grossProfit: pl.grossProfit.toFixed(s),
        operatingProfit: pl.operatingProfit.toFixed(s),
        netIncome: pl.netIncome.toFixed(s),
        grossMargin: sharePercent(pl.grossProfit.toFixed(), pl.operatingRevenue.toFixed()),
        operatingMargin: sharePercent(pl.operatingProfit.toFixed(), pl.operatingRevenue.toFixed()),
        costOfSales: pl.costOfSales.toFixed(s),
        operatingExpenses: pl.operatingExpenses.toFixed(s),
      };
    });
    const total = (key: 'revenue' | 'costOfSales' | 'operatingExpenses' | 'grossProfit' | 'operatingProfit' | 'netIncome') => monthly.reduce((t, m) => t.plus(m[key]), new D(0)).toFixed(s);
    const revenue = total('revenue');
    const revQ = quarterlyTotals(monthly.map((m) => ({ month: m.month, value: m.revenue })), s);
    const netQ = quarterlyTotals(monthly.map((m) => ({ month: m.month, value: m.netIncome })), s);
    const metrics = k.kpis.map((x) => ({ key: x.key, label: x.label, unit: x.unit, group: x.group, better: x.better, formula: x.formula, value: x.value, previous: x.previous, lastYear: x.lastYear, change: x.change, improved: x.improved, series: x.series }));
    return {
      month: k.month,
      inProgress: k.inProgress,
      previousMonth: k.previousMonth,
      sameMonthLastYear: k.sameMonthLastYear,
      metrics,
      movers: biggestMovements(k.kpis.map((x) => ({ key: x.key, label: x.label, value: x.value, previous: x.previous, better: x.better }))),
      versusLastYear: biggestMovements(k.kpis.map((x) => ({ key: x.key, label: x.label, value: x.value, previous: x.lastYear, better: x.better }))),
      monthly,
      twelveMonths: {
        revenue,
        costOfSales: total('costOfSales'),
        operatingExpenses: total('operatingExpenses'),
        grossProfit: total('grossProfit'),
        operatingProfit: total('operatingProfit'),
        netIncome: total('netIncome'),
        costOfSalesShare: sharePercent(total('costOfSales'), revenue),
        operatingExpensesShare: sharePercent(total('operatingExpenses'), revenue),
        netMargin: sharePercent(total('netIncome'), revenue),
      },
      quarters: revQ.map((q, i) => ({ quarter: q.quarter, months: q.months, revenue: q.value, netIncome: netQ[i]!.value, revenueGrowth: i > 0 ? quarterChange(revQ[i - 1]!.value, q.value) : null })),
      customers: { largestShare: k.customers.largestShare, topFiveShare: k.customers.topFiveShare, band: concentrationBand(k.customers.largestShare), top: k.customers.top.map((c) => ({ name: c.name, revenue: c.revenue, share: c.share })) },
    };
  }
}
