'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { KpiUnit } from '@/lib/kpis';
import { money } from '@/lib/format';
import type { RiskLevel } from './risk-monitor';

export type DashboardRole = 'CEO' | 'CFO' | 'TREASURY' | 'RISK' | 'COMPLIANCE' | 'BOARD' | 'AR_MANAGER' | 'AP_MANAGER' | 'TAX_MANAGER' | 'EXPENSE_MANAGER';
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
