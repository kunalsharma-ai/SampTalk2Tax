'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { KpiUnit } from '@/lib/kpis';
import { money } from '@/lib/format';
import type { RiskLevel } from './risk-monitor';

export type DashboardRole = 'CEO' | 'CFO' | 'TREASURY' | 'RISK' | 'COMPLIANCE' | 'BOARD' | 'AR_MANAGER' | 'AP_MANAGER' | 'TAX_MANAGER' | 'EXPENSE_MANAGER' | 'ACCOUNTANT' | 'CONTROLLER' | 'INTERNAL_AUDITOR' | 'PROCUREMENT' | 'PAYROLL_MANAGER' | 'AI_ADMIN' | 'ANALYST' | 'FINANCE_DIRECTOR' | 'DEPARTMENT_MANAGER' | 'EXTERNAL_AUDITOR';
export interface RoleKpi {
  key: string;
  label: string;
  unit: KpiUnit;
  better: 'HIGHER' | 'LOWER';
  formula: string;
  value: string | null;
  reason: string | null;
  previous: string | null;
  change: string | null;
  improved: boolean | null;
  target: { comparator: string; target: string; status: 'MET' | 'MISSED' | 'NO_VALUE' } | null;
  series?: { month: string; value: string | null }[];
}
export interface Attention { area: string; title: string; detail: string; level: 'HIGH' | 'MEDIUM' | 'LOW'; href: string; amount?: string | null }
export interface TaxMonth { month: string; amount: string; low: string; high: string; known: string; payments: number }
export interface TaxTotals { amount: string; low: string; high: string; known: string }

export interface CeoView {
  month: string;
  inProgress: boolean;
  headline: RoleKpi[];
  revenue: { month: string; value: string | null }[];
  cash: { now: string; in90Days: string; lowest: { date: string; amount: string } };
  risk: { score: number; level: RiskLevel; focus: string[] };
  customers: { largestShare: string | null; topFiveShare: string | null; top: { name: string; revenue: string; share: string | null }[] };
  attention: Attention[];
}
export interface CfoView {
  month: string;
  inProgress: boolean;
  profitability: RoleKpi[];
  liquidity: RoleKpi[];
  efficiency: RoleKpi[];
  workingCapital: {
    receivables: { open: string; overdue: string; invoices: number; toChase: string; disputed: string };
    payables: { open: string; overdue: string; bills: number; payNow: string; short: string; offerSavings: string };
  };
  tax: { months: TaxMonth[]; totals: TaxTotals; overdue: number };
}
export interface TreasuryBucket { from: string; to: string; inflow: string; outflow: string; closing: string; low: string; high: string }
export interface TreasuryView {
  accounts: { id: string; code: string; name: string; balance: string }[];
  forecast: {
    horizonDays: number;
    opening: string;
    closing: { base: string; low: string; high: string };
    lowest: { base: { date: string; amount: string }; low: { date: string; amount: string } };
    minimumBalance: string;
    belowBuffer: { base: string | null; low: string | null };
    headroom: { headroom: string; breaks: boolean; lowestOn: string; daysToLowest: number };
    buckets: TreasuryBucket[];
  };
  payments: { summary: { cash: string; payNow: string; onDue: string; short: string; offerSavings: string; offers: number }; bills: { id: string; vendor: string; number: string; dueDate: string; due: string; action: string; actionLabel: string }[] };
  collections: { days: number; expected: string; count: number; invoices: { id: string; customer: string; number: string; expectedOn: string; open: string }[] };
}
export interface RiskOfficerView {
  score: number;
  level: RiskLevel;
  complete: boolean;
  previous: { date: string; score: number; level: RiskLevel } | null;
  areas: { area: string; name: string; href: string; score: number; level: RiskLevel; high: number; medium: number; low: number; available: boolean; active: boolean }[];
  history: { date: string; score: number }[];
  groups: { group: 'CUSTOMERS' | 'VENDORS' | 'CASH' | 'BORROWING'; count: number; total: string; hhi: number; concentration: 'LOW' | 'MODERATE' | 'HIGH' | null; largestShare: number | null }[];
  dependencies: { group: string; name: string; share: number; severity: 'CRITICAL' | 'HIGH' | 'WATCH'; reason: string }[];
  attention: Attention[];
  dependencyPeriod: { from: string; to: string };
}
export interface ComplianceDeadline { key: string; name: string; periodLabel: string; dueDate: string; daysLeft: number; risk: 'HIGH' | 'MEDIUM' | 'LOW'; lateRate: string | null; predictedDate: string | null; reasons: string[] }
export interface ComplianceView {
  configured: boolean;
  days: number;
  summary: { high: number; medium: number; low: number; overdue: number; dueThisWeek: number };
  next: ComplianceDeadline | null;
  deadlines: ComplianceDeadline[];
  tax: { months: TaxMonth[]; totals: TaxTotals; items: { key: string; name: string; periodLabel: string; dueDate: string; method: string; amount: string }[] };
}
export interface BoardQuarter { quarter: string; months: number; revenue: string; grossProfit: string; netIncome: string; closingCash: string; revenueGrowth: string | null }
export interface BoardView {
  month: string;
  inProgress: boolean;
  quarters: BoardQuarter[];
  position: RoleKpi[];
  concentration: { band: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH'; largestShare: string | null; topFiveShare: string | null; customers: number };
}
export interface RoleDashboard {
  role: DashboardRole;
  name: string;
  question: string;
  asOf: string;
  currency: string;
  ceo?: CeoView;
  cfo?: CfoView;
  treasury?: TreasuryView;
  risk?: RiskOfficerView;
  compliance?: ComplianceView;
  board?: BoardView;
  receivables?: ReceivablesView;
  payables?: PayablesView;
  tax?: TaxManagerView;
  expenses?: ExpenseManagerView;
  accountant?: AccountantView;
  controller?: ControllerView;
  audit?: InternalAuditorView;
  procurement?: ProcurementView;
  payroll?: PayrollManagerView;
  ai?: AiAdminView;
  analyst?: AnalystView;
  director?: FinanceDirectorView;
  department?: DepartmentManagerView;
  externalAudit?: ExternalAuditorView;
}

export interface CloseRow { id: string; name: string; startDate: string; endDate: string; periodStatus: string; closeStatus: string; closedBy: string | null; closedAt: string | null; current: boolean }
export interface PendingApprovals { count: number; mine: number; items: { id: string; entryId: string; date: string | null; memo: string | null; total: string; requestedBy: string | null; requestedAt: string; canDecide: boolean }[] }
export interface AccountantView {
  queue: { draftJournals: number; draftDocuments: number; approvals: number; reconciliation: number };
  draftJournals: { id: string; date: string; memo: string | null }[];
  draftDocuments: { kind: string; count: number }[];
  approvals: PendingApprovals;
  reconciliation: { summary: { accounts: number; accountsWithExceptions: number; exceptions: number; needsAction: number }; accounts: { id: string; code: string; name: string; lastReconciled: string | null; exceptions: number; unmatchedStatement: number; unmatchedBook: number }[] };
  close: CloseRow[];
}
export interface ControllerView {
  closes: CloseRow[];
  lateCloses: number;
  approvals: PendingApprovals;
  separation: { from: string; to: string; open: number; reviewed: number; rules: { id: string; title: string; open: number; reviewed: number }[]; membersWithConflicts: number };
  controls: { summary: { passed: number; failed: number; due: number; overdue: number }; total: number; attention: { id: string; title: string; area: string; status: string; owner: string; period: string }[] };
  findings: { open: number; overdue: number; high: number; readyForReview: number };
}
export interface InternalAuditorView {
  engagements: { id: string; reference: string; name: string; status: string; scopeFrom: string; scopeTo: string; lead: string; progress: { steps: number; done: number; signedOff: number }; mine: boolean }[];
  engagementCount: number;
  findings: { summary: { open: number; overdue: number; high: number; readyForReview: number }; open: { id: string; reference: string; title: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; status: string; dueDate: string; overdue: boolean }[] };
  evidence: { summary: { requested: number; submitted: number; accepted: number; overdue: number; mine: number }; outstanding: { id: string; reference: string; title: string; status: string; dueDate: string }[] };
  controls: { summary: { passed: number; failed: number; due: number; overdue: number }; total: number; failed: { id: string; title: string; owner: string; lastTest: { result: string; testedAt: string } | null }[] };
}
export interface ProcurementView {
  orders: {
    totals: { open: number; drafts: number; late: number; toReceive: string; toBill: string };
    late: { id: string; reference: string; vendor: string; expectedDate: string | null; toReceive: string; total: string }[];
    open: { id: string; reference: string; vendor: string; state: string; orderDate: string; expectedDate: string | null; toReceive: string; toBill: string; total: string; late: boolean }[];
  };
  contracts: { summary: { contracts: number; inForce: number; withIssues: number; issues: number; high: number; overcharge: string }; ending: { id: string; reference: string; vendor: string; title: string; endDate: string }[]; issues: { contract: string; vendor: string; severity: 'HIGH' | 'MEDIUM' | 'LOW'; date: string; billNumber: string; detail: string }[] };
  vendors: { totals: { vendors: number; high: number; medium: number; low: number }; risky: { id: string; name: string; level: 'HIGH' | 'MEDIUM'; factors: string[] }[] };
  heldBills: { bills: number; atStake: string };
}

export type AgingBucket = 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'OVER_90';
export interface Aging { total: string; overdue: string; buckets: { bucket: AgingBucket; amount: string; count: number; share: string | null }[] }
export const AGING_LABEL: Record<AgingBucket, string> = { CURRENT: 'Not yet due', DAYS_1_30: '1–30 days late', DAYS_31_60: '31–60 days late', DAYS_61_90: '61–90 days late', OVER_90: 'Over 90 days late' };
export interface ReceivablesView {
  month: string;
  dso: RoleKpi | null;
  aging: Aging;
  doubtful: { count: number };
  overdueCustomers: { contactId: string; name: string; overdue: string; invoices: number; oldestDaysLate: number }[];
  collections: {
    summary: { customers: number; toChase: string; disputed: string; callNow: number };
    customers: { contactId: string; name: string; open: string; overdue: string; disputed: string; toChase: string; oldestOverdueDays: number; overdueInvoices: number; action: string; actionLabel: string; lastReminderOn: string | null }[];
  };
  forecast: { weeks: { from: string; to: string; expected: string; byDueDate: string; invoices: number; cumulative: string }[]; later: { expected: string; invoices: number }; doubtful: { amount: string; invoices: number }; total: string; inHorizon: string };
}
export interface PayablesView {
  month: string;
  dpo: RoleKpi | null;
  aging: Aging;
  payments: { summary: { cash: string; payNow: string; onDue: string; short: string; blocked: string; offerSavings: string; offers: number }; bills: { id: string; vendor: string; number: string; dueDate: string; due: string; action: string; actionLabel: string }[] };
  exceptions: { summary: { bills: number; atStake: string; withVendor: number; awaitingGoods: number; oldestDays: number }; items: { id: string; vendor: string; reference: string | null; order: string; atStake: string; daysHeld: number; nextActionLabel: string }[] };
  fraud: { windowDays: number; summary: { checked: number; flagged: number; high: number; medium: number; low: number }; payments: { vendor: string; date: string; amount: string; currency: string; level: 'HIGH' | 'MEDIUM' | 'LOW' | null }[] };
}
export interface TaxManagerView {
  configured: boolean;
  payments: { totals: TaxTotals; overdue: number; items: { key: string; name: string; area: string; periodLabel: string; dueDate: string; method: string; amount: string; low: string; high: string }[] };
  byArea: { area: string; amount: string; payments: number }[];
  returns: { key: string; name: string; periodLabel: string; dueDate: string; daysLeft: number; risk: 'HIGH' | 'MEDIUM' | 'LOW'; predictedDate: string | null; signals: string[] }[];
  gst: { registered: true; period: string; agrees: boolean; difference: string; unexplained: string; documentsChecked: number; discrepancies: { high: number; medium: number; low: number }; items: number } | { registered: false; period: string };
}
export interface ExpenseManagerView {
  approvals: { count: number; totals: { currency: string; amount: string }[]; oldestDays: number; claims: { id: string; number: string; title: string; claimant: string; currency: string; total: string; submittedOn: string | null }[] };
  risk: { summary: { claims: number; flagged: number; high: number; medium: number; low: number }; items: { claimId: string; title: string; claimant: string; total: string; currency: string; level: 'HIGH' | 'MEDIUM' | 'LOW'; indicators: string[] }[] };
  receipts: { days: number; lines: number; withReceipt: number; missing: number; totals: { currency: string; amount: string }[] };
  budgets: { fiscalYear: number; totals: { budget: string; actual: string; committed: string }; rows: { departmentId: string; name: string; budget: string | null; actual: string; committed: string; status: 'OVER' | 'AT_RISK' | 'ON_TRACK' | 'NO_BUDGET' | string; usedPercent: string | null; reason: string }[] };
}

export interface PayrollMonth { period: string; employees: number; gross: string; net: string; employerCost: string; grossChange: string | null; flagged: boolean }
export interface PayrollManagerView {
  month: string;
  thisMonth: { id: string; number: string; status: string; payDate: string; employees: number; gross: string; net: string; employerCost: string } | null;
  team: { active: number; joining: { id: string; name: string; date: string }[]; joinedThisMonth: { id: string; name: string; date: string }[]; leavingThisMonth: { id: string; name: string; date: string }[] };
  runs: { id: string; number: string; period: string; status: string; payDate: string; employees: number; gross: string; net: string; employerCost: string }[];
  drafts: { id: string; number: string; period: string; missing: number }[];
  unpaid: { items: { runId: string; number: string; period: string; liability: string; label: string; amount: string; dueDate: string | null; overdue: boolean }[]; total: string; overdue: number };
  cost: { from: string; to: string; totals: { employees: number; payslips: number; months: number; gross: string; deductions: string; net: string; employerCost: string; employerContributions: string }; statutory: { key: string; label: string; employee: string; employer: string; total: string }[]; byMonth: PayrollMonth[] };
}
export interface AiAgentRow {
  key: string;
  name: string;
  levelLabel: string;
  enabled: boolean;
  link: string;
  calls: number;
  tokens: number;
  failed: number;
  monthlyTokenLimit: number | null;
  percentOfBudget: number | null;
  budgetReached: boolean;
  nearBudget: boolean;
  cost: string;
  unpricedTokens: number;
  accuracy: { accepted: number; acceptedWithEdits: number; rejected: number; waiting: number; rate: number | null } | null;
  running: number;
  lastUsedAt: string | null;
}
export interface AiAdminView {
  month: string;
  accuracyDays: number;
  configured: boolean;
  provider: string;
  model: string | null;
  enabled: boolean;
  stopped: boolean;
  offReason: string | null;
  platformStopped: boolean;
  totals: { calls: number; tokens: number; failed: number; running: number; waiting: number; cost: string; unpricedTokens: number };
  currency: string;
  agents: AiAgentRow[];
  failures: { id: string; agent: string; startedAt: string; errorName: string | null; stopReason: string | null; model: string }[];
}
export interface AnalystMetric { key: string; label: string; unit: KpiUnit; group: string; better: 'HIGHER' | 'LOWER'; formula: string; value: string | null; previous: string | null; lastYear: string | null; change: string | null; improved: boolean | null; series: { month: string; value: string | null }[] }
export interface Movement { key: string; label: string; value: string; previous: string; changePercent: string; improved: boolean | null }
export interface AnalystMonth { month: string; revenue: string; grossProfit: string; operatingProfit: string; netIncome: string; grossMargin: string | null; operatingMargin: string | null; costOfSales: string; operatingExpenses: string }
export interface AnalystView {
  month: string;
  inProgress: boolean;
  previousMonth: string;
  sameMonthLastYear: string;
  metrics: AnalystMetric[];
  movers: Movement[];
  versusLastYear: Movement[];
  monthly: AnalystMonth[];
  twelveMonths: { revenue: string; costOfSales: string; operatingExpenses: string; grossProfit: string; operatingProfit: string; netIncome: string; costOfSalesShare: string | null; operatingExpensesShare: string | null; netMargin: string | null };
  quarters: { quarter: string; months: number; revenue: string | null; netIncome: string | null; revenueGrowth: string | null }[];
  customers: { largestShare: string | null; topFiveShare: string | null; band: 'NONE' | 'LOW' | 'MODERATE' | 'HIGH'; top: { name: string; revenue: string; share: string | null }[] };
}

export interface PlanFigure { budget: string; actual: string | null; variance: string | null; percent: string | null; favourable: boolean | null }
export interface PlanQuarter { key: string; label: string; started: boolean; inProgress: boolean; revenue: PlanFigure; expenses: PlanFigure; netIncome: PlanFigure }
export interface FinanceDirectorView {
  fiscalYear: number;
  plan: {
    budget: { id: string; name: string; version: number };
    actualsThrough: string | null;
    periodsStarted: number;
    quarters: PlanQuarter[];
    yearToDate: { revenue: PlanFigure; expenses: PlanFigure; netIncome: PlanFigure };
    fullYear: { revenue: string; expenses: string; netIncome: string };
    offPlan: { accountId: string; code: string; name: string; type: 'REVENUE' | 'EXPENSE'; budgeted: boolean; yearToDate: PlanFigure }[];
  } | null;
  departments: { totals: { budget: string; actual: string; committed: string }; over: number; atRisk: number; onTrack: number; noBudget: number; watch: { departmentId: string; name: string; budget: string | null; actual: string; usedPercent: string | null; status: string; reason: string }[] };
  closes: CloseRow[];
  lateCloses: number;
}
export interface DepartmentManagerView {
  fiscalYear: number;
  departments: { id: string; code: string; name: string }[];
  department: {
    id: string;
    code: string;
    name: string;
    from: string;
    to: string;
    budget: { amount: string | null; actual: string; committed: string; remaining: string | null; usedPercent: string | null; expectedByNow: string | null; projected: string; status: string; reason: string } | null;
    spent: string;
    months: { month: string; spent: string; budget: string | null }[];
    accounts: { id: string; code: string; name: string; spent: string; share: string | null }[];
    claims: { id: string; number: string; title: string; claimant: string; currency: string; forDepartment: string; submittedOn: string | null }[];
  } | null;
}
export interface ExternalAuditorView {
  asOf: string;
  years: { fiscalYear: number; label: string; startDate: string; endDate: string; ended: boolean; periods: { open: number; locked: number; closed: number }; status: string; profit: string; accountsLeft: number }[];
  trialBalance: { asOf: string; label: string; balanced: boolean; debit: string; credit: string; accounts: number } | null;
  openPeriodsInEndedYears: number;
  portal: { active: number; links: { id: string; engagementId: string; engagement: string; auditorName: string; firm: string | null; expiresAt: string; lastSeenAt: string | null; viewCount: number; filesOpened: number }[] };
  evidence: { summary: { requested: number; submitted: number; accepted: number } & Record<string, number>; outstanding: { id: string; reference: string; title: string; status: string; dueDate: string }[] };
  findings: { summary: { open: number } & Record<string, number>; open: { id: string; reference: string; title: string; severity: string; status: string; dueDate: string | null; overdue: boolean }[] };
}

const n = (v: string | null) => (v === null ? null : Number(v)); // not money: only to draw
const short = (currency: string) => (v: number) => money(String(Math.round(v)), currency).replace(/\.00$/, ''); // not money: axis ticks
const monthTick = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** Revenue of each month as bars (the CEO's growth view); the table under it has the figures. */
export function RevenueBars({ months, currency }: { months: { month: string; value: string | null }[]; currency: string }) {
  const s = chartSeries;
  return (
    <div className="h-64 w-full px-2" role="img" aria-label="Revenue by month as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={months.map((m) => ({ month: m.month, revenue: n(m.value) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthTick} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} labelFormatter={(l) => monthTick(String(l))} />
          <Bar dataKey="revenue" name="Revenue" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Expected cash at the end of each week with its likely range, and money in and out (the treasury view). */
export function CashRunwayChart({ buckets, currency, buffer }: { buckets: TreasuryBucket[]; currency: string; buffer: string }) {
  const s = chartSeries;
  const data = buckets.map((b) => ({ to: b.to, closing: n(b.closing), range: [n(b.low), n(b.high)], inflow: n(b.inflow), outflow: -(n(b.outflow) ?? 0), buffer: n(buffer) }));
  return (
    <div className="h-72 w-full px-2" role="img" aria-label="Expected cash at the end of each week with its likely range and money in and out; the same figures are in the table below">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="to" tick={{ fontSize: 11 }} tickFormatter={(d: string) => d.slice(5)} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => (Array.isArray(v) ? v.map((x) => money(String(x), currency)).join(' to ') : money(String(v), currency))} />
          <Legend />
          <Area dataKey="range" name="Likely range" stroke="none" fill={s[0]} fillOpacity={0.15} isAnimationActive={false} />
          <Bar dataKey="inflow" name="Money in" fill={s[2]} barSize={10} isAnimationActive={false} />
          <Bar dataKey="outflow" name="Money out" fill={s[3]} barSize={10} isAnimationActive={false} />
          <Line dataKey="closing" name="Expected cash" stroke={s[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
          {Number(buffer) > 0 ? <Line dataKey="buffer" name="Minimum balance" stroke={s[4]} strokeDasharray="4 4" dot={false} isAnimationActive={false} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Revenue and net income of each quarter side by side (the board view). */
export function QuarterBars({ quarters, currency }: { quarters: BoardQuarter[]; currency: string }) {
  const s = chartSeries;
  return (
    <div className="h-64 w-full px-2" role="img" aria-label="Revenue and net income by quarter as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={quarters.map((q) => ({ quarter: q.quarter, revenue: n(q.revenue), net: n(q.netIncome) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} />
          <Legend />
          <Bar dataKey="revenue" name="Revenue" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="net" name="Net income" fill={s[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Open amounts by how late they are, oldest on the right (receivables and payables managers). */
export function AgingBars({ aging, currency, colour }: { aging: Aging; currency: string; colour: number }) {
  const s = chartSeries;
  return (
    <div className="h-56 w-full px-2" role="img" aria-label="Open amounts by how late they are, as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={aging.buckets.map((b) => ({ bucket: AGING_LABEL[b.bucket], amount: n(b.amount) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="bucket" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} />
          <Bar dataKey="amount" name="Open" fill={s[colour]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Gross pay and what the employer pays in all, month by month (the payroll manager's cost view). */
export function PayrollCostBars({ months, currency }: { months: PayrollMonth[]; currency: string }) {
  const s = chartSeries;
  return (
    <div className="h-60 w-full px-2" role="img" aria-label="Gross pay and employer cost by month as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={months.map((m) => ({ month: m.period, gross: n(m.gross), cost: n(m.employerCost) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthTick} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} labelFormatter={(l) => monthTick(String(l))} />
          <Legend />
          <Bar dataKey="gross" name="Gross pay" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="cost" name="Employer cost" fill={s[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Revenue as bars with gross and operating margin as lines, month by month (the analyst's profit view). */
export function MarginChart({ months, currency }: { months: AnalystMonth[]; currency: string }) {
  const s = chartSeries;
  return (
    <div className="h-72 w-full px-2" role="img" aria-label="Revenue by month as bars with gross and operating margin as lines; the same figures are in the table below">
      <ResponsiveContainer>
        <ComposedChart data={months.map((m) => ({ month: m.month, revenue: n(m.revenue), gross: n(m.grossMargin), operating: n(m.operatingMargin) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthTick} tick={{ fontSize: 11 }} />
          <YAxis yAxisId="money" tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <YAxis yAxisId="pct" orientation="right" tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11 }} width={48} />
          <Tooltip formatter={(v, name) => (name === 'Revenue' ? money(String(v), currency) : `${v}%`)} labelFormatter={(l) => monthTick(String(l))} />
          <Legend />
          <Bar yAxisId="money" dataKey="revenue" name="Revenue" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Line yAxisId="pct" dataKey="gross" name="Gross margin" stroke={s[2]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line yAxisId="pct" dataKey="operating" name="Operating margin" stroke={s[3]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A department's spending each month against an even share of its yearly budget (the department manager's view). */
export function DepartmentSpendChart({ months, currency }: { months: { month: string; spent: string; budget: string | null }[]; currency: string }) {
  const s = chartSeries;
  const withBudget = months.some((m) => m.budget !== null);
  return (
    <div className="h-60 w-full px-2" role="img" aria-label="Department spending by month as bars against a monthly share of its budget; the same figures are in the table below">
      <ResponsiveContainer>
        <ComposedChart data={months.map((m) => ({ month: m.month, spent: n(m.spent), budget: n(m.budget) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="month" tickFormatter={monthTick} tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} labelFormatter={(l) => monthTick(String(l))} />
          <Legend />
          <Bar dataKey="spent" name="Spent" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          {withBudget ? <Line dataKey="budget" name="Monthly share of budget" stroke={s[4]} strokeDasharray="4 4" dot={false} isAnimationActive={false} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Net income of each quarter, planned against actual (the finance director's view). */
export function PlanQuarterBars({ quarters, currency }: { quarters: PlanQuarter[]; currency: string }) {
  const s = chartSeries;
  return (
    <div className="h-60 w-full px-2" role="img" aria-label="Planned and actual net income by quarter as bars; the same figures are in the table below">
      <ResponsiveContainer>
        <BarChart data={quarters.map((q) => ({ quarter: q.key, plan: n(q.netIncome.budget), actual: n(q.netIncome.actual) }))} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--t2t-border)" vertical={false} />
          <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={short(currency)} tick={{ fontSize: 11 }} width={88} />
          <Tooltip formatter={(v) => money(String(v), currency)} />
          <Legend />
          <Bar dataKey="plan" name="Planned net income" fill={s[4]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="actual" name="Actual net income" fill={s[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
