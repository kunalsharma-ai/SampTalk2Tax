/**
 * The virtual CFO: a financial health assessment, analyses and answers to common finance
 * questions, each worked out here from posted figures. Every result says which records it
 * used, the period, how it was calculated, what it assumes, how sure it is, what to do next
 * and who has to approve it.
 *
 * An AI model may write an executive summary of these results, but only from them:
 * `checkSummaryFigures` rejects a summary that quotes any figure not found in the facts it was
 * given. No framework or database code. Money is decimal strings.
 */
import { plFigures, type MonthFigures } from './kpis';
import { D, Dec } from './money';
import type { TwinResult } from './twin';
import { formatAmountText, formatDateText } from './workflows';

// ------------------------------------------------------------------ shapes

export const CFO_AREAS = ['LIQUIDITY', 'PROFITABILITY', 'WORKING_CAPITAL', 'GROWTH', 'COSTS', 'RISK', 'DEBT', 'CAPITAL', 'PLANNING'] as const;
export type CfoArea = (typeof CFO_AREAS)[number];
export type CfoVerdict = 'GOOD' | 'WATCH' | 'ACT' | 'NO_DATA';
export type CfoConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type CfoUnit = 'MONEY' | 'PERCENT' | 'DAYS' | 'MONTHS' | 'RATIO' | 'COUNT' | 'TEXT';

export interface CfoFigure {
  label: string;
  /** Decimal string, or text for TEXT; null when it cannot be worked out. */
  value: string | null;
  unit: CfoUnit;
}
export interface CfoSource {
  label: string;
  /** Page inside the organisation, such as /reports/income-statement. */
  path: string;
}
export interface CfoAction {
  text: string;
  path: string | null;
  /** Who has to agree before it is done, or null when no approval is needed. */
  approval: string | null;
}
export interface CfoTable {
  columns: { key: string; label: string; unit: CfoUnit }[];
  rows: Record<string, string | number | null>[];
}
export interface CfoFinding {
  key: string;
  area: CfoArea;
  title: string;
  verdict: CfoVerdict;
  /** One or two sentences with the figures that matter, written here, never by a model. */
  summary: string;
  figures: CfoFigure[];
  period: { from: string; to: string; label: string };
  method: string;
  assumptions: string[];
  confidence: CfoConfidence;
  confidenceReason: string;
  sources: CfoSource[];
  actions: CfoAction[];
  table?: CfoTable;
}

export interface CfoAccountMonths {
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  subtype: string | null;
  /** Movement in each month of `CfoInput.months`, same order: revenue as a positive credit, expenses as a positive debit. */
  amounts: string[];
}
export interface CfoCustomer {
  name: string;
  revenue12: string;
  revenuePrev12: string;
  overdue: string;
  /** Average days paid after the due date over the last 12 months; null without history. */
  averageDaysLate: number | null;
  paidInvoices: number;
}

export interface CfoInput {
  currency: string;
  scale: number;
  today: string;
  /** Up to 24 calendar months of posted figures, oldest first, ending with the last complete month. */
  months: MonthFigures[];
  accounts: CfoAccountMonths[];
  customers: CfoCustomer[];
  /** The minimum cash balance set for the cash-flow forecast, or null. */
  minimumCash: string | null;
  /** The 90-day cash-flow forecast from open invoices, bills and planned items. */
  forecast: { horizonDays: number; opening: string; closing: string; lowest: { date: string; amount: string }; lowestLow: { date: string; amount: string }; belowMinimumOn: string | null } | null;
  borrowings: { count: number; outstanding: string; repaymentsNext12: string; interestNext12: string } | null;
  /** Statutory items overdue or due in the next 45 days, from the compliance calendar. */
  compliance: { name: string; dueDate: string; status: 'OVERDUE' | 'DUE_SOON' | 'UPCOMING'; amount: string | null }[];
  alerts: { high: number; active: number };
  budget: { fiscalYear: number; approved: boolean; netVariance: string | null; revenueVariance: string | null; expensesVariance: string | null } | null;
  scenarios: { total: number; approved: number; inReview: number };
}

export interface CfoHealth {
  score: number;
  grade: 'STRONG' | 'FAIR' | 'WEAK' | 'CRITICAL';
  components: { key: string; label: string; points: number; max: number; reason: string }[];
}

export interface CfoAssessment {
  currency: string;
  asOf: string;
  lastMonth: string;
  health: CfoHealth;
  headline: string;
  findings: CfoFinding[];
  recommendations: (CfoAction & { area: CfoArea; why: string; priority: 'HIGH' | 'MEDIUM' })[];
}

// ------------------------------------------------------------------ helpers

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const sum = (xs: Dec[]) => xs.reduce((a, b) => a.plus(b), new D(0));
const pct = (a: Dec, b: Dec) => a.dividedBy(b).times(100);
const p1 = (x: Dec | null) => (x === null ? null : x.toDecimalPlaces(1).toFixed(1));
const r2 = (x: Dec | null) => (x === null ? null : x.toDecimalPlaces(2).toFixed(2));
const d0 = (x: Dec | null) => (x === null ? null : x.toDecimalPlaces(0).toFixed(0));
const active = (m: MonthFigures) => !m.operatingRevenue.isZero() || !m.costOfSales.isZero() || !m.operatingExpenses.isZero() || !m.otherExpenses.isZero();
/** Percent change from b to a, null when b is zero. */
const change = (a: Dec, b: Dec) => (b.isZero() ? null : a.minus(b).dividedBy(b.abs()).times(100));

function range(ms: MonthFigures[]) {
  if (!ms.length) return { from: '', to: '', label: '' };
  const label = ms.length === 1 ? monthLabel(ms[0].month) : `${monthLabel(ms[0].month)} to ${monthLabel(ms[ms.length - 1].month)}`;
  return { from: ms[0].from, to: ms[ms.length - 1].to, label };
}

class Fmt {
  constructor(
    private readonly currency: string,
    private readonly scale: number,
  ) {}
  money = (x: Dec | string) => formatAmountText(new D(x).toFixed(this.scale), this.currency);
  pct = (x: Dec | null) => (x === null ? 'n/a' : `${x.toDecimalPlaces(1).toFixed(1)}%`);
  days = (x: Dec | null) => (x === null ? 'n/a' : `${x.toDecimalPlaces(0).toFixed(0)} days`);
  m = (x: Dec) => x.toFixed(this.scale);
}

function windows(months: MonthFigures[]) {
  const n = months.length;
  const last3 = months.slice(Math.max(0, n - 3));
  const prev3 = months.slice(Math.max(0, n - 6), Math.max(0, n - 3));
  const ly3 = n >= 15 ? months.slice(n - 15, n - 12) : [];
  const t12 = months.slice(Math.max(0, n - 12));
  const p12 = n >= 24 ? months.slice(n - 24, n - 12) : [];
  return { last: months[n - 1], last3, prev3, ly3, t12, p12 };
}
const total = (ms: MonthFigures[], k: keyof Pick<MonthFigures, 'operatingRevenue' | 'otherIncome' | 'costOfSales' | 'operatingExpenses' | 'payroll' | 'depreciation' | 'interest' | 'incomeTax' | 'otherExpenses' | 'cashChange'>) => sum(ms.map((m) => m[k]));
const net = (ms: MonthFigures[]) => sum(ms.map((m) => plFigures(m).netIncome));
const gross = (ms: MonthFigures[]) => sum(ms.map((m) => plFigures(m).grossProfit));
const operating = (ms: MonthFigures[]) => sum(ms.map((m) => plFigures(m).operatingProfit));
const days = (ms: MonthFigures[]) => ms.reduce((a, m) => a + m.days, 0);

function balance(m: MonthFigures) {
  const currentAssets = m.cash.plus(m.receivables).plus(m.inventory).plus(m.otherCurrentAssets);
  const currentLiabilities = m.payables.plus(m.otherCurrentLiabilities);
  const liabilities = currentLiabilities.plus(m.nonCurrentLiabilities);
  const equity = currentAssets.plus(m.nonCurrentAssets).minus(liabilities);
  return { currentAssets, currentLiabilities, liabilities, equity };
}

const SRC = {
  pl: { label: 'Profit and loss', path: '/reports/income-statement' },
  bs: { label: 'Balance sheet', path: '/reports/balance-sheet' },
  kpis: { label: 'KPIs', path: '/reports/kpis' },
  cash: { label: 'Cash-flow forecast', path: '/planning/cash-flow' },
  ar: { label: 'Receivables ageing', path: '/sales/ageing' },
  ap: { label: 'Payables ageing', path: '/purchases/ageing' },
  loans: { label: 'Treasury', path: '/treasury' },
  compliance: { label: 'Compliance calendar', path: '/tax/compliance' },
  alerts: { label: 'Alerts', path: '/alerts' },
  budget: { label: 'Budget vs actual', path: '/planning/budget-vs-actual' },
  twin: { label: 'Digital twin', path: '/planning/twin' },
  recovery: { label: 'Recovery planner', path: '/planning/recovery' },
  projects: { label: 'Profit by project', path: '/reports/profit-by-dimension?type=PROJECT' },
  bills: { label: 'Bills', path: '/purchases/bills' },
} satisfies Record<string, CfoSource>;

// ------------------------------------------------------------------ the assessment

/** Working capital measures at one month end, using the three months up to it. */
function cycle(months: MonthFigures[]) {
  const m = months[months.length - 1];
  const w = months.slice(-3);
  const dd = days(w);
  const rev = total(w, 'operatingRevenue');
  const cos = total(w, 'costOfSales');
  const spend = sum(w.map((x) => x.costOfSales.plus(x.operatingExpenses).minus(x.payroll).minus(x.depreciation)));
  const dso = rev.greaterThan(0) ? m.receivables.dividedBy(rev).times(dd) : null;
  const dpo = spend.greaterThan(0) ? m.payables.dividedBy(spend).times(dd) : null;
  const dio = cos.greaterThan(0) && m.inventory.greaterThan(0) ? m.inventory.dividedBy(cos).times(dd) : m.inventory.isZero() ? new D(0) : null;
  const ccc = dso !== null && dpo !== null && dio !== null ? dso.plus(dio).minus(dpo) : null;
  return { dso, dpo, dio, ccc };
}

export function cfoAssessment(input: CfoInput): CfoAssessment {
  if (!input.months.length) throw new Error('No months');
  const f = new Fmt(input.currency, input.scale);
  const w = windows(input.months);
  const m = w.last;
  const b = balance(m);
  const findings: CfoFinding[] = [];
  const hasLast3 = w.last3.some(active);
  const hasPrev3 = w.prev3.some(active);
  const hasLy3 = w.ly3.some(active);
  const asOfLabel = `${formatDateText(m.to)}`;

  // ---- liquidity
  const burn = total(w.last3, 'cashChange').dividedBy(Math.max(1, w.last3.length));
  const runway = burn.lessThan(0) && m.cash.greaterThan(0) ? m.cash.dividedBy(burn.negated()) : null;
  const currentRatio = b.currentLiabilities.greaterThan(0) ? b.currentAssets.dividedBy(b.currentLiabilities) : null;
  const quickRatio = b.currentLiabilities.greaterThan(0) ? m.cash.plus(m.receivables).dividedBy(b.currentLiabilities) : null;
  const fc = input.forecast;
  const minimum = input.minimumCash ? new D(input.minimumCash) : new D(0);
  const fcShort = fc ? D.max(0, minimum.minus(fc.lowest.amount)) : null;
  const liqVerdict: CfoVerdict =
    m.cash.lessThanOrEqualTo(0) || (runway && runway.lessThan(6)) || (fcShort && fcShort.greaterThan(0)) ? 'ACT' : (currentRatio && currentRatio.lessThan(1.2)) || (runway && runway.lessThan(12)) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'LIQUIDITY',
    area: 'LIQUIDITY',
    title: 'Liquidity',
    verdict: liqVerdict,
    summary: [
      `Cash and bank stood at ${f.money(m.cash)} on ${asOfLabel}.`,
      burn.lessThan(0) ? `Cash fell by ${f.money(burn.negated())} a month on average over the last ${w.last3.length} months${runway ? `, which lasts about ${runway.toDecimalPlaces(1).toFixed(1)} months at that pace` : ''}.` : `Cash grew by ${f.money(burn)} a month on average over the last ${w.last3.length} months.`,
      fc ? (fcShort!.greaterThan(0) ? `The ${fc.horizonDays}-day forecast falls to ${f.money(fc.lowest.amount)} on ${formatDateText(fc.lowest.date)}, ${f.money(fcShort!)} short of the minimum balance.` : `The ${fc.horizonDays}-day forecast stays at or above ${f.money(fc.lowest.amount)} (lowest on ${formatDateText(fc.lowest.date)}).`) : '',
    ]
      .filter(Boolean)
      .join(' '),
    figures: [
      { label: 'Cash and bank', value: f.m(m.cash), unit: 'MONEY' },
      { label: 'Current ratio', value: r2(currentRatio), unit: 'RATIO' },
      { label: 'Quick ratio', value: r2(quickRatio), unit: 'RATIO' },
      { label: 'Average monthly change in cash', value: f.m(burn.toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Runway', value: runway ? runway.toDecimalPlaces(1).toFixed(1) : null, unit: 'MONTHS' },
      ...(fc ? [{ label: `Lowest cash in the next ${fc.horizonDays} days`, value: fc.lowest.amount, unit: 'MONEY' as const }] : []),
    ],
    period: { from: w.last3[0].from, to: m.to, label: `${range(w.last3).label}, balances at ${asOfLabel}` },
    method: 'Current ratio = current assets ÷ current liabilities. Quick ratio = (cash + receivables) ÷ current liabilities. Runway = cash ÷ average monthly fall in cash over the last three months. The forecast uses open invoices and bills at the dates customers and suppliers usually pay, and planned items.',
    assumptions: ['Assets without a subtype count as non-current and liabilities without one as current.', 'The forecast assumes customers and suppliers keep paying as they have.', ...(input.minimumCash ? [`Minimum cash balance: ${f.money(input.minimumCash)}.`] : ['No minimum cash balance is set, so the forecast is compared with zero.'])],
    confidence: fc ? 'HIGH' : 'MEDIUM',
    confidenceReason: fc ? 'Balances come straight from the ledger; the forecast is based on open items.' : 'Balances come from the ledger; there is no forecast to check against.',
    sources: [SRC.bs, SRC.kpis, SRC.cash],
    actions:
      liqVerdict === 'ACT'
        ? [
            { text: 'Build a recovery plan to close the cash gap', path: SRC.recovery.path, approval: 'Owner approval for financing or payroll measures' },
            { text: 'Chase overdue invoices', path: '/sales/collections', approval: null },
          ]
        : liqVerdict === 'WATCH'
          ? [{ text: 'Review the cash-flow forecast weekly', path: SRC.cash.path, approval: null }]
          : [],
  });

  // ---- profitability
  const rev3 = total(w.last3, 'operatingRevenue');
  const revP3 = total(w.prev3, 'operatingRevenue');
  const gm = (ms: MonthFigures[]) => {
    const r = total(ms, 'operatingRevenue');
    return r.greaterThan(0) ? pct(gross(ms), r) : null;
  };
  const nm = (ms: MonthFigures[]) => {
    const r = total(ms, 'operatingRevenue').plus(total(ms, 'otherIncome'));
    return r.greaterThan(0) ? pct(net(ms), r) : null;
  };
  const [gm3, gmP3, nm3, nmP3, nmLy3] = [gm(w.last3), hasPrev3 ? gm(w.prev3) : null, nm(w.last3), hasPrev3 ? nm(w.prev3) : null, hasLy3 ? nm(w.ly3) : null];
  const net3 = net(w.last3);
  const profVerdict: CfoVerdict = !hasLast3 ? 'NO_DATA' : net3.lessThan(0) ? 'ACT' : nm3 && nmP3 && nm3.minus(nmP3).lessThan(-3) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'PROFITABILITY',
    area: 'PROFITABILITY',
    title: 'Profitability',
    verdict: profVerdict,
    summary: !hasLast3
      ? 'There are no posted revenue or expenses in the last three months.'
      : [
          `${net3.lessThan(0) ? 'A net loss' : 'Net profit'} of ${f.money(net3.abs())} on revenue of ${f.money(rev3)} over ${range(w.last3).label}.`,
          `Gross margin ${f.pct(gm3)}${gmP3 ? ` (${f.pct(gmP3)} in the three months before)` : ''}, net margin ${f.pct(nm3)}${nmP3 ? ` (${f.pct(nmP3)} before)` : ''}.`,
        ].join(' '),
    figures: [
      { label: 'Revenue', value: f.m(rev3), unit: 'MONEY' },
      { label: 'Gross profit', value: f.m(gross(w.last3)), unit: 'MONEY' },
      { label: 'Operating profit', value: f.m(operating(w.last3)), unit: 'MONEY' },
      { label: 'Net profit', value: f.m(net3), unit: 'MONEY' },
      { label: 'Gross margin', value: p1(gm3), unit: 'PERCENT' },
      { label: 'Net margin', value: p1(nm3), unit: 'PERCENT' },
      { label: 'Net margin, previous three months', value: p1(nmP3), unit: 'PERCENT' },
      { label: 'Net margin, same months last year', value: p1(nmLy3), unit: 'PERCENT' },
    ],
    period: range(w.last3),
    method: 'Gross margin = (revenue − cost of sales) ÷ revenue. Net margin = net profit ÷ (revenue + other income). Three months are taken together so one unusual month counts less.',
    assumptions: ['Only posted journals count; drafts and unposted documents are left out.', 'Expenses are grouped by their account subtype.'],
    confidence: hasPrev3 ? 'HIGH' : 'MEDIUM',
    confidenceReason: hasPrev3 ? 'Figures come from posted journals and there is history to compare with.' : 'Figures come from posted journals but there is little history to compare with.',
    sources: [SRC.pl, SRC.kpis],
    actions: profVerdict === 'ACT' ? [{ text: 'See why profit changed and which costs grew', path: null, approval: null }, { text: 'Test a price rise or cost cut on the digital twin', path: SRC.twin.path, approval: null }] : [],
  });

  // ---- working capital
  const c = cycle(input.months);
  const cPrev = input.months.length > 3 ? cycle(input.months.slice(0, -3)) : null;
  const overdue = sum(input.customers.map((x) => new D(x.overdue)));
  const overdueShare = m.receivables.greaterThan(0) ? pct(overdue, m.receivables) : null;
  const wcVerdict: CfoVerdict = c.dso === null ? 'NO_DATA' : (c.dso.greaterThan(60) || (overdueShare && overdueShare.greaterThan(40))) ? 'ACT' : c.dso.greaterThan(45) || (cPrev?.dso && c.dso.minus(cPrev.dso).greaterThan(10)) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'WORKING_CAPITAL',
    area: 'WORKING_CAPITAL',
    title: 'Working capital',
    verdict: wcVerdict,
    summary:
      c.dso === null
        ? 'There is no revenue in the last three months to measure collection days against.'
        : [
            `Customers take ${f.days(c.dso)} to pay${cPrev?.dso ? ` (${f.days(cPrev.dso)} three months earlier)` : ''} and suppliers are paid in ${f.days(c.dpo)}.`,
            c.ccc !== null ? `Cash is tied up for ${f.days(c.ccc)} between paying for costs and collecting from customers.` : '',
            overdue.greaterThan(0) ? `${f.money(overdue)} of receivables is overdue (${f.pct(overdueShare)} of the total).` : 'No receivables are overdue.',
          ]
            .filter(Boolean)
            .join(' '),
    figures: [
      { label: 'Days sales outstanding', value: d0(c.dso), unit: 'DAYS' },
      { label: 'Days payables outstanding', value: d0(c.dpo), unit: 'DAYS' },
      { label: 'Days inventory', value: d0(c.dio), unit: 'DAYS' },
      { label: 'Cash conversion cycle', value: d0(c.ccc), unit: 'DAYS' },
      { label: 'Receivables', value: f.m(m.receivables), unit: 'MONEY' },
      { label: 'Overdue receivables', value: f.m(overdue), unit: 'MONEY' },
      { label: 'Payables', value: f.m(m.payables), unit: 'MONEY' },
      { label: 'Working capital', value: f.m(b.currentAssets.minus(b.currentLiabilities)), unit: 'MONEY' },
    ],
    period: { from: w.last3[0].from, to: m.to, label: `Balances at ${asOfLabel}, activity ${range(w.last3).label}` },
    method: 'DSO = receivables ÷ revenue of the last three months × days in them. DPO = payables ÷ (cost of sales and operating expenses other than payroll and depreciation) × days. Days inventory = inventory ÷ cost of sales × days. Cash conversion cycle = DSO + days inventory − DPO.',
    assumptions: ['Overdue amounts are from the receivables ageing today; balances are at the last month end.'],
    confidence: 'HIGH',
    confidenceReason: 'Balances and activity come straight from the ledger.',
    sources: [SRC.kpis, SRC.ar, SRC.ap],
    actions: wcVerdict === 'ACT' || wcVerdict === 'WATCH' ? [{ text: 'Draft payment reminders for overdue customers', path: '/sales/collections', approval: 'A person reviews and sends each reminder' }, { text: 'Ask the largest suppliers for longer terms', path: SRC.recovery.path, approval: 'Owner approval before changing supplier terms' }] : [],
  });

  // ---- growth
  const revLy3 = total(w.ly3, 'operatingRevenue');
  const rev12 = total(w.t12, 'operatingRevenue');
  const revP12 = total(w.p12, 'operatingRevenue');
  const g3 = hasPrev3 ? change(rev3, revP3) : null;
  const gYoy = hasLy3 ? change(rev3, revLy3) : null;
  const g12 = w.p12.some(active) ? change(rev12, revP12) : null;
  const customers = [...input.customers].sort((a, b) => new D(b.revenue12).comparedTo(a.revenue12));
  const top = customers[0];
  const totalCustomers = sum(customers.map((x) => new D(x.revenue12)));
  const topShare = top && totalCustomers.greaterThan(0) ? pct(new D(top.revenue12), totalCustomers) : null;
  const growthVerdict: CfoVerdict = !hasLast3 ? 'NO_DATA' : (g3 && g3.lessThan(-10)) || (gYoy && gYoy.lessThan(-10)) ? 'ACT' : (g3 && g3.lessThan(0)) || (topShare && topShare.greaterThan(40)) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'GROWTH',
    area: 'GROWTH',
    title: 'Revenue growth',
    verdict: growthVerdict,
    summary: !hasLast3
      ? 'There is no revenue in the last three months.'
      : [
          `Revenue was ${f.money(rev3)} over ${range(w.last3).label}${g3 !== null ? `, ${g3.greaterThanOrEqualTo(0) ? 'up' : 'down'} ${f.pct(g3.abs())} on the three months before` : ''}${gYoy !== null ? ` and ${gYoy.greaterThanOrEqualTo(0) ? 'up' : 'down'} ${f.pct(gYoy.abs())} on the same months last year` : ''}.`,
          top && topShare ? `The largest customer, ${top.name}, brought ${f.pct(topShare)} of the last 12 months' invoiced revenue.` : '',
        ]
          .filter(Boolean)
          .join(' '),
    figures: [
      { label: 'Revenue, last three months', value: f.m(rev3), unit: 'MONEY' },
      { label: 'Change on the three months before', value: p1(g3), unit: 'PERCENT' },
      { label: 'Change on the same months last year', value: p1(gYoy), unit: 'PERCENT' },
      { label: 'Revenue, last 12 months', value: f.m(rev12), unit: 'MONEY' },
      { label: 'Change on the 12 months before', value: p1(g12), unit: 'PERCENT' },
      { label: 'Largest customer share', value: p1(topShare), unit: 'PERCENT' },
    ],
    period: range(w.t12),
    method: 'Growth = (revenue in the period − revenue in the comparison period) ÷ revenue in the comparison period. Customer share uses posted invoices less credit notes over the last 12 months.',
    assumptions: ['Revenue is operating revenue; other income is left out.', 'A comparison is only made when the earlier period has posted activity.'],
    confidence: hasLy3 ? 'HIGH' : hasPrev3 ? 'MEDIUM' : 'LOW',
    confidenceReason: hasLy3 ? 'More than a year of history.' : hasPrev3 ? 'Less than a year of history, so seasonality cannot be checked.' : 'Too little history to compare.',
    sources: [SRC.pl, SRC.kpis],
    actions: growthVerdict === 'ACT' ? [{ text: 'Test a price rise or a new customer on the digital twin', path: SRC.twin.path, approval: 'Owner approval before changing prices' }] : topShare && topShare.greaterThan(40) ? [{ text: 'Reduce dependence on the largest customer', path: null, approval: null }] : [],
  });

  // ---- costs
  const costs = costIncreases(input);
  const opex3 = total(w.last3, 'operatingExpenses');
  const opexP3 = total(w.prev3, 'operatingExpenses');
  const opexG = hasPrev3 ? change(opex3, opexP3) : null;
  const costVerdict: CfoVerdict = !hasLast3 ? 'NO_DATA' : opexG && g3 !== null && opexG.minus(g3).greaterThan(10) ? 'ACT' : costs.length ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'COSTS',
    area: 'COSTS',
    title: 'Costs',
    verdict: costVerdict,
    summary: !hasLast3
      ? 'There are no posted expenses in the last three months.'
      : [
          `Operating expenses were ${f.money(opex3)} over ${range(w.last3).label}${opexG !== null ? `, ${opexG.greaterThanOrEqualTo(0) ? 'up' : 'down'} ${f.pct(opexG.abs())}` : ''}${g3 !== null ? ` while revenue moved ${f.pct(g3)}` : ''}.`,
          costs.length ? `${costs.length} cost line${costs.length === 1 ? '' : 's'} grew by more than 15%; the largest is ${costs[0].name}, up ${f.money(costs[0].increase)} a month.` : 'No cost line grew by more than 15%.',
        ].join(' '),
    figures: [
      { label: 'Operating expenses, last three months', value: f.m(opex3), unit: 'MONEY' },
      { label: 'Change on the three months before', value: p1(opexG), unit: 'PERCENT' },
      { label: 'Operating expenses ÷ revenue', value: rev3.greaterThan(0) ? p1(pct(opex3, rev3)) : null, unit: 'PERCENT' },
      { label: 'Possible saving a month (bring growing lines back)', value: f.m(sum(costs.map((x) => new D(x.increase)))), unit: 'MONEY' },
    ],
    period: range(w.last3),
    method: 'Each expense account: the average of the last three months against the average of the six months before. Lines up by more than 15% and by more than 1% of monthly revenue are listed.',
    assumptions: ['A growing cost may be planned (new staff, a new office); the list shows where to look, not what to cut.'],
    confidence: input.months.length >= 9 ? 'MEDIUM' : 'LOW',
    confidenceReason: input.months.length >= 9 ? 'Nine months of history per account.' : 'Short history per account.',
    sources: [SRC.pl],
    actions: costs.slice(0, 3).map((x) => ({ text: `Review ${x.name} (${x.code}): up ${f.money(x.increase)} a month`, path: SRC.pl.path, approval: 'The budget owner agrees any cut' })),
    table: costs.length
      ? {
          columns: [
            { key: 'account', label: 'Account', unit: 'TEXT' },
            { key: 'recent', label: 'Average, last 3 months', unit: 'MONEY' },
            { key: 'before', label: 'Average, 6 months before', unit: 'MONEY' },
            { key: 'increase', label: 'Up a month', unit: 'MONEY' },
            { key: 'percent', label: 'Change', unit: 'PERCENT' },
          ],
          rows: costs.map((x) => ({ account: `${x.code} ${x.name}`, recent: x.recent, before: x.before, increase: x.increase, percent: x.percent })),
        }
      : undefined,
  });

  // ---- debt
  const t12Interest = total(w.t12, 'interest');
  const ebit12 = sum(w.t12.map((x) => plFigures(x).operatingProfit));
  const cover = t12Interest.greaterThan(0) ? ebit12.dividedBy(t12Interest) : null;
  const de = b.equity.greaterThan(0) ? b.liabilities.dividedBy(b.equity) : null;
  const bo = input.borrowings;
  const ebitda12 = sum(w.t12.map((x) => plFigures(x).operatingProfit.plus(x.depreciation)));
  const service = bo ? new D(bo.repaymentsNext12).plus(bo.interestNext12) : new D(0);
  const dscr = service.greaterThan(0) ? ebitda12.dividedBy(service) : null;
  const debtVerdict: CfoVerdict = b.equity.lessThanOrEqualTo(0) || (cover && cover.lessThan(1.5)) || (dscr && dscr.lessThan(1)) ? 'ACT' : (cover && cover.lessThan(3)) || (de && de.greaterThan(2)) || (dscr && dscr.lessThan(1.25)) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'DEBT',
    area: 'DEBT',
    title: 'Debt',
    verdict: debtVerdict,
    summary: [
      bo && bo.count ? `${bo.count} loan${bo.count === 1 ? '' : 's'} with ${f.money(bo.outstanding)} outstanding; ${f.money(service)} of principal and interest falls due in the next 12 months.` : 'No loans are recorded in Talk2Tax.',
      cover !== null ? `Operating profit covered interest ${cover.toDecimalPlaces(1).toFixed(1)} times over the last 12 months.` : '',
      dscr !== null ? `Operating cash earnings (EBITDA) cover the next 12 months' repayments ${dscr.toDecimalPlaces(2).toFixed(2)} times.` : '',
      b.equity.lessThanOrEqualTo(0) ? `Liabilities exceed assets by ${f.money(b.equity.negated())}.` : `Liabilities are ${de ? de.toDecimalPlaces(2).toFixed(2) : 'n/a'} times equity.`,
    ]
      .filter(Boolean)
      .join(' '),
    figures: [
      { label: 'Loans outstanding', value: bo ? bo.outstanding : f.m(new D(0)), unit: 'MONEY' },
      { label: 'Repayments and interest, next 12 months', value: f.m(service), unit: 'MONEY' },
      { label: 'Interest cover', value: cover ? cover.toDecimalPlaces(1).toFixed(1) : null, unit: 'RATIO' },
      { label: 'Debt service cover', value: r2(dscr), unit: 'RATIO' },
      { label: 'Liabilities ÷ equity', value: r2(de), unit: 'RATIO' },
      { label: 'Equity', value: f.m(b.equity), unit: 'MONEY' },
    ],
    period: range(w.t12),
    method: 'Interest cover = operating profit ÷ interest expense over the last 12 months. Debt service cover = EBITDA of the last 12 months ÷ principal and interest due in the next 12 months from the loan schedules. Liabilities ÷ equity at the last month end.',
    assumptions: ['The next 12 months are assumed to earn what the last 12 did.', 'Only loans recorded in Talk2Tax have schedules.'],
    confidence: bo ? 'HIGH' : 'MEDIUM',
    confidenceReason: bo ? 'Repayments come from the loan schedules.' : 'There are no loan schedules to read repayments from.',
    sources: [SRC.loans, SRC.bs, SRC.pl],
    actions: debtVerdict === 'ACT' ? [{ text: 'Talk to the lender about rescheduling before a repayment is missed', path: SRC.loans.path, approval: 'Owner or board approval to renegotiate a loan' }] : debtVerdict === 'WATCH' ? [{ text: 'Avoid new borrowing until interest cover improves', path: null, approval: null }] : [],
  });

  // ---- capital allocation and expansion
  const fixed3 = sum(w.last3.map((x) => x.operatingExpenses.plus(x.interest))).dividedBy(Math.max(1, w.last3.length));
  const reserve = D.max(minimum, fixed3.times(3));
  const free = m.cash.minus(reserve);
  const expansionMonths = free.greaterThan(0) && fixed3.greaterThan(0) ? free.dividedBy(fixed3.times(0.2)) : null;
  const capVerdict: CfoVerdict = free.greaterThan(0) ? 'GOOD' : 'WATCH';
  findings.push({
    key: 'CAPITAL',
    area: 'CAPITAL',
    title: 'Capital allocation and expansion',
    verdict: capVerdict,
    summary: free.greaterThan(0)
      ? `After keeping a reserve of ${f.money(reserve)} (three months of fixed costs${input.minimumCash ? ' or the minimum balance, whichever is higher' : ''}), ${f.money(free)} of cash is free to invest, repay debt or fund growth. It would pay for an expansion that adds a fifth to fixed costs for about ${expansionMonths!.toDecimalPlaces(0).toFixed(0)} months before it earns anything.`
      : `Cash of ${f.money(m.cash)} is below a reserve of ${f.money(reserve)} (three months of fixed costs${input.minimumCash ? ' or the minimum balance' : ''}), so there is no free cash to commit to new spending.`,
    figures: [
      { label: 'Cash and bank', value: f.m(m.cash), unit: 'MONEY' },
      { label: 'Monthly fixed costs', value: f.m(fixed3.toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Reserve', value: f.m(reserve.toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Free cash', value: f.m(free.toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Months an expansion adding 20% to fixed costs could be funded', value: expansionMonths ? expansionMonths.toDecimalPlaces(0).toFixed(0) : null, unit: 'MONTHS' },
    ],
    period: { from: w.last3[0].from, to: m.to, label: `Cash at ${asOfLabel}, costs ${range(w.last3).label}` },
    method: 'Fixed costs = average monthly operating expenses and interest over the last three months. Reserve = the larger of three months of fixed costs and the minimum cash balance. Free cash = cash − reserve.',
    assumptions: ['Three months of fixed costs is a common prudent reserve; set a minimum cash balance to use your own.', 'The expansion test assumes no extra revenue at first.'],
    confidence: 'MEDIUM',
    confidenceReason: 'The reserve rule is a convention, not a fact from the books.',
    sources: [SRC.bs, SRC.pl, SRC.cash],
    actions: free.greaterThan(0)
      ? [
          { text: 'Model the expansion on the digital twin before committing', path: `${SRC.twin.path}/new?template=EXPANSION`, approval: 'Owner or board approval before committing capital' },
          ...(bo && bo.count ? [{ text: 'Compare prepaying the most expensive loan with investing', path: SRC.loans.path, approval: 'Owner approval for a prepayment' }] : []),
        ]
      : [{ text: 'Hold new commitments until cash rebuilds', path: null, approval: null }],
  });

  // ---- risks
  const risks = riskList(input, { burnRunway: runway, net3, topShare, topName: top?.name ?? null, equity: b.equity, fcShort, cover, f });
  const highRisks = risks.filter((r) => r.level === 'HIGH').length;
  findings.push({
    key: 'RISK',
    area: 'RISK',
    title: 'Financial risks',
    verdict: highRisks ? 'ACT' : risks.length ? 'WATCH' : 'GOOD',
    summary: risks.length ? `${risks.length} risk${risks.length === 1 ? '' : 's'} found, ${highRisks} high: ${risks.map((r) => r.text.replace(/\.$/, '')).slice(0, 3).join('; ')}.` : 'No financial risks found in the books today.',
    figures: [
      { label: 'Risks found', value: String(risks.length), unit: 'COUNT' },
      { label: 'High risks', value: String(highRisks), unit: 'COUNT' },
      { label: 'Active alerts', value: String(input.alerts.active), unit: 'COUNT' },
    ],
    period: { from: w.last3[0].from, to: input.today, label: `Up to ${formatDateText(input.today)}` },
    method: 'Rules on the figures above: runway under six months, a loss over the last three months, one customer over 40% of revenue, negative equity, the forecast below the minimum balance, interest cover under 1.5, overdue statutory filings, and high-severity alerts.',
    assumptions: ['Thresholds are common rules of thumb; they flag what to look at, not what will happen.'],
    confidence: 'MEDIUM',
    confidenceReason: 'Each risk is a rule on posted figures.',
    sources: [SRC.alerts, SRC.compliance, SRC.kpis],
    actions: risks.filter((r) => r.action).map((r) => r.action!) as CfoAction[],
    table: risks.length
      ? { columns: [{ key: 'level', label: 'Level', unit: 'TEXT' }, { key: 'risk', label: 'Risk', unit: 'TEXT' }], rows: risks.map((r) => ({ level: r.level, risk: r.text })) }
      : undefined,
  });

  // ---- planning
  const bud = input.budget;
  const planVerdict: CfoVerdict = !bud?.approved ? 'WATCH' : bud.netVariance && new D(bud.netVariance).lessThan(0) ? 'WATCH' : 'GOOD';
  findings.push({
    key: 'PLANNING',
    area: 'PLANNING',
    title: 'Planning',
    verdict: planVerdict,
    summary: [
      bud?.approved
        ? `FY${bud.fiscalYear} has an approved budget. Net profit so far is ${bud.netVariance && new D(bud.netVariance).greaterThanOrEqualTo(0) ? `${f.money(bud.netVariance)} ahead of` : `${f.money(new D(bud.netVariance ?? 0).abs())} behind`} the budget.`
        : `FY${bud?.fiscalYear ?? ''} has no approved budget, so results cannot be checked against a plan.`.replace('FY has', 'This year has'),
      `${input.scenarios.total} digital-twin scenario${input.scenarios.total === 1 ? '' : 's'} saved, ${input.scenarios.approved} approved and ${input.scenarios.inReview} waiting for a decision.`,
    ].join(' '),
    figures: [
      { label: 'Net profit against budget, year to date', value: bud?.netVariance ?? null, unit: 'MONEY' },
      { label: 'Revenue against budget, year to date', value: bud?.revenueVariance ?? null, unit: 'MONEY' },
      { label: 'Expenses against budget, year to date', value: bud?.expensesVariance ?? null, unit: 'MONEY' },
      { label: 'Scenarios saved', value: String(input.scenarios.total), unit: 'COUNT' },
      { label: 'Scenarios approved', value: String(input.scenarios.approved), unit: 'COUNT' },
    ],
    period: { from: '', to: input.today, label: bud ? `FY${bud.fiscalYear} to date` : 'This fiscal year' },
    method: 'Budget variance = actual − approved budget for the months of the fiscal year so far (a positive revenue or net profit variance is favourable; a positive expense variance means spending above budget).',
    assumptions: [],
    confidence: 'HIGH',
    confidenceReason: 'From the approved budget and posted figures.',
    sources: [SRC.budget, SRC.twin],
    actions: bud?.approved ? [] : [{ text: 'Prepare a budget for this fiscal year', path: '/planning/budgets', approval: 'Owner or admin approves the budget' }],
  });

  // ---- health score: five parts of 20 points, rules stated in each reason
  const health = healthScore({ m, net3, nm3, runway, currentRatio, dso: c.dso, g3, gYoy, equity: b.equity, cover, hasLast3, f });
  const order: Record<CfoVerdict, number> = { ACT: 0, WATCH: 1, GOOD: 2, NO_DATA: 3 };
  const recommendations = findings
    .filter((x) => x.verdict === 'ACT' || x.verdict === 'WATCH')
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .flatMap((x) => x.actions.slice(0, 2).map((a) => ({ ...a, area: x.area, why: x.summary.split('. ')[0].replace(/\.$/, '') + '.', priority: (x.verdict === 'ACT' ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM' })))
    .filter((a, i, all) => all.findIndex((b) => b.text === a.text) === i)
    .slice(0, 8);
  const act = findings.filter((x) => x.verdict === 'ACT').map((x) => x.title.toLowerCase());
  const headline =
    `Financial health is ${health.grade.toLowerCase()} (${health.score} out of 100). ` +
    (act.length ? `Needs action on ${act.join(', ')}.` : findings.some((x) => x.verdict === 'WATCH') ? `Keep an eye on ${findings.filter((x) => x.verdict === 'WATCH').map((x) => x.title.toLowerCase()).join(', ')}.` : 'Nothing needs action today.');
  return { currency: input.currency, asOf: m.to, lastMonth: m.month, health, headline, findings, recommendations };
}

function healthScore(p: { m: MonthFigures; net3: Dec; nm3: Dec | null; runway: Dec | null; currentRatio: Dec | null; dso: Dec | null; g3: Dec | null; gYoy: Dec | null; equity: Dec; cover: Dec | null; hasLast3: boolean; f: Fmt }): CfoHealth {
  const comp: CfoHealth['components'] = [];
  // Liquidity: cash lasting and current ratio.
  let liq = 0;
  if (p.m.cash.greaterThan(0)) liq += p.runway === null ? 12 : p.runway.greaterThanOrEqualTo(12) ? 10 : p.runway.greaterThanOrEqualTo(6) ? 6 : 2;
  if (p.currentRatio === null || p.currentRatio.greaterThanOrEqualTo(1.5)) liq += 8;
  else if (p.currentRatio.greaterThanOrEqualTo(1)) liq += 4;
  comp.push({ key: 'LIQUIDITY', label: 'Liquidity', points: Math.min(20, liq), max: 20, reason: `Cash ${p.runway === null ? (p.m.cash.greaterThan(0) ? 'is not falling' : 'is nil') : `lasts ${p.runway.toDecimalPlaces(1).toFixed(1)} months`}; current ratio ${p.currentRatio ? p.currentRatio.toDecimalPlaces(2).toFixed(2) : 'n/a'}. 12 points if cash is not falling (10 for 12+ months of runway, 6 for 6+, 2 below), 8 for a current ratio of 1.5 or more (4 for 1 or more).` });
  // Profitability: net margin.
  const prof = !p.hasLast3 || p.nm3 === null ? 0 : p.nm3.greaterThanOrEqualTo(15) ? 20 : p.nm3.greaterThanOrEqualTo(5) ? 15 : p.nm3.greaterThanOrEqualTo(0) ? 10 : p.nm3.greaterThanOrEqualTo(-10) ? 4 : 0;
  comp.push({ key: 'PROFITABILITY', label: 'Profitability', points: prof, max: 20, reason: `Net margin over the last three months ${p.f.pct(p.nm3)}. 20 points at 15% or more, 15 at 5%, 10 at break-even, 4 down to −10%.` });
  // Working capital: DSO.
  const wc = p.dso === null ? 10 : p.dso.lessThanOrEqualTo(30) ? 20 : p.dso.lessThanOrEqualTo(45) ? 15 : p.dso.lessThanOrEqualTo(60) ? 10 : p.dso.lessThanOrEqualTo(90) ? 5 : 0;
  comp.push({ key: 'WORKING_CAPITAL', label: 'Working capital', points: wc, max: 20, reason: `Customers take ${p.f.days(p.dso)} to pay. 20 points at 30 days or less, 15 to 45, 10 to 60, 5 to 90; 10 when there is no revenue to measure.` });
  // Growth.
  const g = p.gYoy ?? p.g3;
  const gr = g === null ? 10 : g.greaterThanOrEqualTo(10) ? 20 : g.greaterThanOrEqualTo(0) ? 14 : g.greaterThanOrEqualTo(-10) ? 7 : 0;
  comp.push({ key: 'GROWTH', label: 'Growth', points: gr, max: 20, reason: `Revenue ${g === null ? 'cannot be compared yet' : `${g.greaterThanOrEqualTo(0) ? 'up' : 'down'} ${p.f.pct(g.abs())} ${p.gYoy ? 'on the same months last year' : 'on the three months before'}`}. 20 points at +10% or more, 14 at 0%, 7 down to −10%; 10 without history.` });
  // Solvency.
  let sol = p.equity.greaterThan(0) ? 10 : 0;
  sol += p.cover === null ? 10 : p.cover.greaterThanOrEqualTo(3) ? 10 : p.cover.greaterThanOrEqualTo(1.5) ? 5 : 0;
  comp.push({ key: 'SOLVENCY', label: 'Solvency', points: sol, max: 20, reason: `Equity ${p.equity.greaterThan(0) ? 'is positive' : 'is zero or negative'}; interest cover ${p.cover ? p.cover.toDecimalPlaces(1).toFixed(1) : 'n/a (no interest)'}. 10 points for positive equity, 10 for cover of 3 or more or no interest (5 for 1.5).` });
  const score = comp.reduce((a, x) => a + x.points, 0);
  return { score, grade: score >= 75 ? 'STRONG' : score >= 50 ? 'FAIR' : score >= 25 ? 'WEAK' : 'CRITICAL', components: comp };
}

function riskList(input: CfoInput, p: { burnRunway: Dec | null; net3: Dec; topShare: Dec | null; topName: string | null; equity: Dec; fcShort: Dec | null; cover: Dec | null; f: Fmt }) {
  const out: { level: 'HIGH' | 'MEDIUM'; text: string; action: CfoAction | null }[] = [];
  if (p.burnRunway && p.burnRunway.lessThan(6)) out.push({ level: 'HIGH', text: `Cash lasts about ${p.burnRunway.toDecimalPlaces(1).toFixed(1)} months at the current pace.`, action: { text: 'Build a recovery plan', path: SRC.recovery.path, approval: null } });
  if (p.fcShort && p.fcShort.greaterThan(0)) out.push({ level: 'HIGH', text: `The cash forecast falls ${p.f.money(p.fcShort)} below the minimum balance.`, action: { text: 'Open the cash-flow forecast', path: SRC.cash.path, approval: null } });
  if (p.net3.lessThan(0)) out.push({ level: 'HIGH', text: `A net loss of ${p.f.money(p.net3.abs())} over the last three months.`, action: null });
  if (p.equity.lessThanOrEqualTo(0)) out.push({ level: 'HIGH', text: 'Liabilities exceed assets (negative equity).', action: { text: 'Discuss new capital or restructuring with the owners', path: null, approval: 'Owner or board decision' } });
  if (p.cover && p.cover.lessThan(1.5)) out.push({ level: 'HIGH', text: `Operating profit covers interest only ${p.cover.toDecimalPlaces(1).toFixed(1)} times.`, action: null });
  if (p.topShare && p.topShare.greaterThan(40)) out.push({ level: 'MEDIUM', text: `${p.topName} brings ${p.f.pct(p.topShare)} of revenue.`, action: null });
  const overdue = input.compliance.filter((x) => x.status === 'OVERDUE');
  if (overdue.length) out.push({ level: 'HIGH', text: `${overdue.length} statutory filing or payment${overdue.length === 1 ? ' is' : 's are'} overdue.`, action: { text: 'Open the compliance calendar', path: SRC.compliance.path, approval: null } });
  if (input.alerts.high) out.push({ level: 'MEDIUM', text: `${input.alerts.high} high-severity alert${input.alerts.high === 1 ? '' : 's'} open.`, action: { text: 'Review the alerts', path: SRC.alerts.path, approval: null } });
  return out;
}

/** Expense accounts whose last three months average more than 15% above the six months before. */
export function costIncreases(input: Pick<CfoInput, 'accounts' | 'months' | 'scale'>) {
  const n = input.months.length;
  if (n < 4) return [];
  const rev = sum(input.months.slice(-3).map((m) => m.operatingRevenue)).dividedBy(3);
  const floor = rev.times(0.01);
  const priorCount = Math.min(6, n - 3);
  return input.accounts
    .filter((a) => a.type === 'EXPENSE' && a.subtype !== 'TAX_EXPENSE' && a.subtype !== 'DEPRECIATION')
    .map((a) => {
      const amts = a.amounts.map((x) => new D(x));
      const recent = sum(amts.slice(-3)).dividedBy(3);
      const before = sum(amts.slice(n - 3 - priorCount, n - 3)).dividedBy(priorCount);
      const inc = recent.minus(before);
      return { code: a.code, name: a.name, recent: recent.toFixed(input.scale), before: before.toFixed(input.scale), increase: inc.toFixed(input.scale), percent: before.greaterThan(0) ? p1(pct(inc, before)) : null, inc, ok: inc.greaterThan(floor) && (before.isZero() ? recent.greaterThan(0) : inc.dividedBy(before).greaterThan(0.15)) };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.inc.comparedTo(a.inc))
    .map(({ inc: _inc, ok: _ok, ...x }) => x);
}

// ------------------------------------------------------------------ questions

export const CFO_QUESTIONS = [
  { key: 'PROFIT_CHANGE', question: 'Why did profit change last month?' },
  { key: 'CLIENT_PROFITABILITY', question: 'Which clients are most profitable?' },
  { key: 'PROJECT_LOSSES', question: 'Which projects are losing money?' },
  { key: 'CASH_NEXT_QUARTER', question: 'How much cash will we need next quarter?' },
  { key: 'EXPENSES_TO_INVESTIGATE', question: 'What expenses should we investigate?' },
  { key: 'SALARY_RISE', question: 'What happens if salaries increase by 10%?' },
  { key: 'VENDOR_PRICES', question: 'Which vendors are charging more than expected?' },
  { key: 'TAX_EXPOSURE', question: 'What is our current tax exposure?' },
  { key: 'LATE_INVOICES', question: 'Which invoices are likely to be paid late?' },
] as const;
export type CfoQuestionKey = (typeof CFO_QUESTIONS)[number]['key'];
export type CfoAnswer = CfoFinding & { question: string };

function answer(key: CfoQuestionKey, f: Omit<CfoFinding, 'key'>): CfoAnswer {
  return { key, question: CFO_QUESTIONS.find((q) => q.key === key)!.question, ...f };
}

/** Why net profit moved between the last complete month and the month before: the accounts that moved it most. */
export function profitChange(input: Pick<CfoInput, 'months' | 'accounts' | 'currency' | 'scale'>): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const n = input.months.length;
  if (n < 2) throw new Error('Two months are needed');
  const [prev, cur] = [input.months[n - 2], input.months[n - 1]];
  const [np, nc] = [plFigures(prev).netIncome, plFigures(cur).netIncome];
  const diff = nc.minus(np);
  const drivers = input.accounts
    .map((a) => {
      const was = new D(a.amounts[n - 2] ?? 0);
      const now = new D(a.amounts[n - 1] ?? 0);
      // Effect on profit: more revenue raises it, more expense lowers it.
      const effect = a.type === 'REVENUE' ? now.minus(was) : was.minus(now);
      return { account: `${a.code} ${a.name}`, type: a.type, was: was.toFixed(input.scale), now: now.toFixed(input.scale), effect };
    })
    .filter((x) => !x.effect.isZero())
    .sort((a, b) => b.effect.abs().comparedTo(a.effect.abs()));
  const against = drivers.filter((x) => (diff.lessThan(0) ? x.effect.lessThan(0) : x.effect.greaterThan(0))).slice(0, 3);
  const dir = diff.lessThan(0) ? 'fell' : diff.greaterThan(0) ? 'rose' : 'did not change';
  const why = against.map((x) => `${x.account} (${x.type === 'REVENUE' ? (x.effect.greaterThan(0) ? 'up' : 'down') : x.effect.greaterThan(0) ? 'down' : 'up'} ${f.money(x.effect.abs())})`).join(', ');
  return answer('PROFIT_CHANGE', {
    area: 'PROFITABILITY',
    title: `Net profit ${dir} in ${monthLabel(cur.month)}`,
    verdict: diff.lessThan(0) ? 'WATCH' : 'GOOD',
    summary: diff.isZero() ? `Net profit was ${f.money(nc)} in both ${monthLabel(prev.month)} and ${monthLabel(cur.month)}.` : `Net profit ${dir} by ${f.money(diff.abs())}, from ${f.money(np)} in ${monthLabel(prev.month)} to ${f.money(nc)} in ${monthLabel(cur.month)}.${why ? ` The largest causes: ${why}.` : ''}`,
    figures: [
      { label: `Net profit, ${monthLabel(prev.month)}`, value: f.m(np), unit: 'MONEY' },
      { label: `Net profit, ${monthLabel(cur.month)}`, value: f.m(nc), unit: 'MONEY' },
      { label: 'Change', value: f.m(diff), unit: 'MONEY' },
      { label: 'Revenue change', value: f.m(cur.operatingRevenue.plus(cur.otherIncome).minus(prev.operatingRevenue).minus(prev.otherIncome)), unit: 'MONEY' },
    ],
    period: { from: prev.from, to: cur.to, label: `${monthLabel(prev.month)} against ${monthLabel(cur.month)}` },
    method: 'Each revenue and expense account in the month against the month before. Its effect on profit is the change in revenue, or minus the change in expense; accounts are listed by the size of the effect.',
    assumptions: ['A month that is still open may change when more is posted.', 'Only posted journals count.'],
    confidence: 'HIGH',
    confidenceReason: 'Straight from posted journals, account by account.',
    sources: [{ label: `Profit and loss, ${monthLabel(cur.month)}`, path: `/reports/income-statement?from=${cur.from}&to=${cur.to}` }, { label: `Profit and loss, ${monthLabel(prev.month)}`, path: `/reports/income-statement?from=${prev.from}&to=${prev.to}` }],
    actions: against.filter((x) => x.type === 'EXPENSE' && x.effect.lessThan(0)).slice(0, 2).map((x) => ({ text: `Check what was posted to ${x.account}`, path: SRC.pl.path, approval: null })),
    table: {
      columns: [
        { key: 'account', label: 'Account', unit: 'TEXT' },
        { key: 'was', label: monthLabel(prev.month), unit: 'MONEY' },
        { key: 'now', label: monthLabel(cur.month), unit: 'MONEY' },
        { key: 'effect', label: 'Effect on profit', unit: 'MONEY' },
      ],
      rows: drivers.slice(0, 10).map((x) => ({ account: x.account, was: x.was, now: x.now, effect: x.effect.toFixed(input.scale) })),
    },
  });
}

/** Clients ranked by revenue and how promptly they pay. Costs are not recorded per client, which the answer says. */
export function clientProfitability(input: Pick<CfoInput, 'customers' | 'currency' | 'scale' | 'today'>): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const rows = [...input.customers].filter((c) => !new D(c.revenue12).isZero()).sort((a, b) => new D(b.revenue12).comparedTo(a.revenue12));
  const tot = sum(rows.map((r) => new D(r.revenue12)));
  const top = rows.slice(0, 3);
  return answer('CLIENT_PROFITABILITY', {
    area: 'PROFITABILITY',
    title: 'Clients by revenue and payment',
    verdict: rows.length ? 'GOOD' : 'NO_DATA',
    summary: rows.length
      ? `Over the last 12 months the largest clients were ${top.map((r) => `${r.name} (${f.money(r.revenue12)}, ${f.pct(pct(new D(r.revenue12), tot))})`).join(', ')}. Talk2Tax does not record costs per client, so this ranks clients by revenue and how promptly they pay, not by profit.`
      : 'No invoiced revenue in the last 12 months.',
    figures: [
      { label: 'Invoiced revenue, last 12 months', value: f.m(tot), unit: 'MONEY' },
      { label: 'Clients invoiced', value: String(rows.length), unit: 'COUNT' },
    ],
    period: { from: '', to: input.today, label: 'Last 12 months' },
    method: 'Revenue from posted invoices less credit notes, by client, over the last 12 months. Average days late is from invoices paid in full in that time.',
    assumptions: ['Costs of serving each client are not in the books, so profit per client cannot be worked out. Tag invoices and bills with a project per client to measure it with Profit by project.'],
    confidence: 'LOW',
    confidenceReason: 'Revenue is exact, but without costs per client it shows revenue, not profit.',
    sources: [{ label: 'KPIs (customer concentration)', path: '/reports/kpis' }, SRC.ar, SRC.projects],
    actions: rows.some((r) => r.averageDaysLate !== null && r.averageDaysLate > 30) ? [{ text: 'Review terms with clients who pay more than 30 days late', path: '/sales/collections', approval: null }] : [],
    table: {
      columns: [
        { key: 'client', label: 'Client', unit: 'TEXT' },
        { key: 'revenue', label: 'Revenue, 12 months', unit: 'MONEY' },
        { key: 'share', label: 'Share', unit: 'PERCENT' },
        { key: 'change', label: 'Change on the year before', unit: 'PERCENT' },
        { key: 'overdue', label: 'Overdue now', unit: 'MONEY' },
        { key: 'late', label: 'Average days late', unit: 'DAYS' },
      ],
      rows: rows.slice(0, 15).map((r) => ({ client: r.name, revenue: r.revenue12, share: tot.greaterThan(0) ? p1(pct(new D(r.revenue12), tot)) : null, change: p1(change(new D(r.revenue12), new D(r.revenuePrev12))), overdue: r.overdue, late: r.averageDaysLate })),
    },
  });
}

/** Projects with a net loss over the period, from the profit by project report. */
export function projectLosses(input: { currency: string; scale: number; from: string; to: string; projects: { code: string | null; name: string; revenue: string; expenses: string; net: string; margin: string | null }[] }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const rows = input.projects.filter((p) => p.code !== null);
  const losing = rows.filter((p) => new D(p.net).lessThan(0)).sort((a, b) => new D(a.net).comparedTo(b.net));
  const period = { from: input.from, to: input.to, label: `${formatDateText(input.from)} to ${formatDateText(input.to)}` };
  return answer('PROJECT_LOSSES', {
    area: 'PROFITABILITY',
    title: losing.length ? `${losing.length} project${losing.length === 1 ? ' is' : 's are'} losing money` : 'No project is losing money',
    verdict: !rows.length ? 'NO_DATA' : losing.length ? 'WATCH' : 'GOOD',
    summary: !rows.length
      ? 'No projects are set up, or nothing has been posted to one. Tag invoice, bill and journal lines with a project to measure them.'
      : losing.length
        ? `${losing.map((p) => `${p.name} lost ${f.money(new D(p.net).abs())}`).slice(0, 3).join('; ')} over ${period.label}.`
        : `All ${rows.length} projects made a profit or broke even over ${period.label}.`,
    figures: [
      { label: 'Projects with activity', value: String(rows.length), unit: 'COUNT' },
      { label: 'Losing money', value: String(losing.length), unit: 'COUNT' },
      { label: 'Total loss on those projects', value: f.m(sum(losing.map((p) => new D(p.net)))), unit: 'MONEY' },
    ],
    period,
    method: 'Revenue minus expenses posted with each project over the period. Lines with no project are not counted.',
    assumptions: ['Shared costs not tagged to a project (rent, admin) are left out, so project profit is before overheads.'],
    confidence: rows.length ? 'MEDIUM' : 'LOW',
    confidenceReason: 'Depends on how fully lines are tagged with a project.',
    sources: [{ label: 'Profit by project', path: `/reports/profit-by-dimension?type=PROJECT&from=${input.from}&to=${input.to}` }],
    actions: losing.slice(0, 2).map((p) => ({ text: `Review pricing and costs on ${p.name}`, path: `/reports/profit-by-dimension?type=PROJECT&from=${input.from}&to=${input.to}`, approval: 'The project owner agrees any change' })),
    table: { columns: [{ key: 'project', label: 'Project', unit: 'TEXT' }, { key: 'revenue', label: 'Revenue', unit: 'MONEY' }, { key: 'expenses', label: 'Expenses', unit: 'MONEY' }, { key: 'net', label: 'Profit', unit: 'MONEY' }, { key: 'margin', label: 'Margin', unit: 'PERCENT' }], rows: rows.map((p) => ({ project: `${p.code} ${p.name}`, revenue: p.revenue, expenses: p.expenses, net: p.net, margin: p.margin })) },
  });
}

/** Cash to raise over the next 90 days to stay at or above the minimum balance, from the forecast and the twin. */
export function cashNextQuarter(input: Pick<CfoInput, 'forecast' | 'minimumCash' | 'currency' | 'scale' | 'today'> & { twin: TwinResult | null }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const fc = input.forecast;
  const min = new D(input.minimumCash ?? 0);
  const needBase = fc ? D.max(0, min.minus(fc.lowest.amount)) : null;
  const needLow = fc ? D.max(0, min.minus(fc.lowestLow.amount)) : null;
  const twinNeed = input.twin ? new D(input.twin.projection.cashRequired) : null;
  const tw = input.twin?.projection;
  return answer('CASH_NEXT_QUARTER', {
    area: 'LIQUIDITY',
    title: needBase && needBase.greaterThan(0) ? `About ${f.money(needBase)} is needed next quarter` : 'No extra cash is needed next quarter',
    verdict: !fc ? 'NO_DATA' : needBase!.greaterThan(0) ? 'ACT' : needLow!.greaterThan(0) ? 'WATCH' : 'GOOD',
    summary: !fc
      ? 'The cash-flow forecast could not be worked out.'
      : [
          `Cash starts at ${f.money(fc.opening)} and the forecast's lowest point in the next ${fc.horizonDays} days is ${f.money(fc.lowest.amount)} on ${formatDateText(fc.lowest.date)}.`,
          needBase!.greaterThan(0) ? `To stay at the minimum balance of ${f.money(min)}, ${f.money(needBase!)} more is needed.` : `That keeps cash at or above ${input.minimumCash ? `the minimum balance of ${f.money(min)}` : 'zero'}.`,
          needLow!.greaterThan(needBase!) ? `If customers pay as late as they have at their slowest, the need is ${f.money(needLow!)}.` : '',
          tw ? `On recent trends (the digital twin, three months) cash would end at ${f.money(tw.months[Math.min(2, tw.months.length - 1)].closingCash)}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
    figures: [
      { label: 'Cash today', value: fc?.opening ?? null, unit: 'MONEY' },
      { label: 'Lowest forecast cash', value: fc?.lowest.amount ?? null, unit: 'MONEY' },
      { label: 'Lowest, if customers pay late', value: fc?.lowestLow.amount ?? null, unit: 'MONEY' },
      { label: 'Cash needed (forecast)', value: needBase ? f.m(needBase) : null, unit: 'MONEY' },
      { label: 'Cash needed if customers pay late', value: needLow ? f.m(needLow) : null, unit: 'MONEY' },
      { label: 'Cash needed on recent trends (twin)', value: twinNeed ? f.m(twinNeed) : null, unit: 'MONEY' },
    ],
    period: { from: input.today, to: fc ? addDaysIso(input.today, fc.horizonDays) : input.today, label: `Next ${fc?.horizonDays ?? 90} days` },
    method: 'Cash needed = minimum balance − the lowest forecast balance, if positive. The forecast places each open invoice and bill at the date that customer or supplier usually pays, adds planned items, and shows a late case. The twin projects the last six months of posted figures forward.',
    assumptions: ['New sales and costs not yet invoiced or billed are only in the twin, not the forecast.', ...(input.minimumCash ? [] : ['No minimum balance is set, so the need is measured against zero.'])],
    confidence: fc ? 'MEDIUM' : 'LOW',
    confidenceReason: 'Open items are exact; when they will be paid is an estimate from past behaviour.',
    sources: [SRC.cash, SRC.twin],
    actions: needBase && needBase.greaterThan(0) ? [{ text: 'Build a recovery plan for the gap', path: SRC.recovery.path, approval: 'Owner approval for any loan or new capital' }] : [],
  });
}

/** Expense accounts unusually high last month, and possible leakage from the alert checks. */
export function expensesToInvestigate(input: Pick<CfoInput, 'months' | 'accounts' | 'currency' | 'scale'> & { leakage: { title: string; amount: string | null; severity: string }[] }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const n = input.months.length;
  const cur = input.months[n - 1];
  const priorCount = Math.min(6, n - 1);
  const floor = sum(input.months.slice(-3).map((m) => m.operatingRevenue)).dividedBy(3).times(0.005);
  const spikes = input.accounts
    .filter((a) => a.type === 'EXPENSE')
    .map((a) => {
      const now = new D(a.amounts[n - 1] ?? 0);
      const avg = priorCount ? sum(a.amounts.slice(n - 1 - priorCount, n - 1).map((x) => new D(x))).dividedBy(priorCount) : new D(0);
      return { account: `${a.code} ${a.name}`, now, avg, over: now.minus(avg) };
    })
    .filter((x) => x.over.greaterThan(floor) && x.over.greaterThan(0) && (x.avg.isZero() || x.now.dividedBy(x.avg).greaterThan(1.25)))
    .sort((a, b) => b.over.comparedTo(a.over));
  return answer('EXPENSES_TO_INVESTIGATE', {
    area: 'COSTS',
    title: spikes.length || input.leakage.length ? `${spikes.length + input.leakage.length} expense item${spikes.length + input.leakage.length === 1 ? '' : 's'} to look at` : 'No unusual expenses',
    verdict: spikes.length || input.leakage.length ? 'WATCH' : 'GOOD',
    summary: [
      spikes.length ? `In ${monthLabel(cur.month)}, ${spikes.slice(0, 3).map((x) => `${x.account} was ${f.money(x.now)} against an average of ${f.money(x.avg.toDecimalPlaces(input.scale))}`).join('; ')}.` : `No expense account in ${monthLabel(cur.month)} was more than 25% above its recent average.`,
      input.leakage.length ? `The leakage checks also flag ${input.leakage.length} item${input.leakage.length === 1 ? '' : 's'}, such as ${input.leakage[0].title}.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    figures: [
      { label: 'Accounts above their average', value: String(spikes.length), unit: 'COUNT' },
      { label: 'Amount above average', value: f.m(sum(spikes.map((x) => x.over)).toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Leakage alerts', value: String(input.leakage.length), unit: 'COUNT' },
    ],
    period: { from: cur.from, to: cur.to, label: `${monthLabel(cur.month)} against the ${priorCount} months before` },
    method: 'Each expense account in the last complete month against its average over the six months before. Listed when more than 25% above it and by more than 0.5% of monthly revenue. Leakage alerts are possible duplicate bills or payments and unusual journals from the alert checks.',
    assumptions: ['A one-off cost may be legitimate (an annual fee, a repair); the list shows where to look.'],
    confidence: 'MEDIUM',
    confidenceReason: 'The figures are exact; whether a cost is wrong needs a person to check.',
    sources: [SRC.pl, SRC.alerts],
    actions: [...spikes.slice(0, 2).map((x) => ({ text: `Open the ledger for ${x.account}`, path: SRC.pl.path, approval: null })), ...(input.leakage.length ? [{ text: 'Review the leakage alerts', path: SRC.alerts.path, approval: null }] : [])],
    table: {
      columns: [{ key: 'item', label: 'Item', unit: 'TEXT' }, { key: 'now', label: monthLabel(cur.month), unit: 'MONEY' }, { key: 'avg', label: 'Average before', unit: 'MONEY' }, { key: 'over', label: 'Above average', unit: 'MONEY' }],
      rows: [
        ...spikes.map((x) => ({ item: x.account, now: x.now.toFixed(input.scale), avg: x.avg.toFixed(input.scale), over: x.over.toFixed(input.scale) })),
        ...input.leakage.map((l) => ({ item: `Alert: ${l.title}`, now: l.amount, avg: null, over: null })),
      ],
    },
  });
}

/** Payroll up 10% from next month, measured on the digital twin against no change. */
export function salaryRise(input: { currency: string; scale: number; base: TwinResult; withRise: TwinResult; percent: string }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const [b, r] = [input.base.projection, input.withRise.projection];
  const extra = new D(input.base.baseline.payroll).times(input.percent).dividedBy(100);
  const profitDiff = new D(r.totals.netProfit).minus(b.totals.netProfit);
  const h = b.months.length;
  return answer('SALARY_RISE', {
    area: 'PROFITABILITY',
    title: `Salaries up ${input.percent}%: ${f.money(profitDiff.abs())} ${profitDiff.lessThan(0) ? 'less' : 'more'} profit over ${h} months`,
    verdict: r.cashNegativeFrom ? 'ACT' : new D(r.totals.netProfit).lessThan(0) ? 'WATCH' : 'GOOD',
    summary: [
      `Payroll averages ${f.money(input.base.baseline.payroll)} a month; ${input.percent}% more is about ${f.money(extra.toDecimalPlaces(input.scale))} a month.`,
      `Over ${h} months net profit would be ${f.money(r.totals.netProfit)} instead of ${f.money(b.totals.netProfit)}, and cash at the end ${f.money(r.closingCash)} instead of ${f.money(b.closingCash)}.`,
      r.cashNegativeFrom ? `Cash would run out in ${monthLabel(r.cashNegativeFrom)}${b.cashNegativeFrom ? ` (${monthLabel(b.cashNegativeFrom)} without the rise)` : ''}.` : `Cash stays positive; the lowest point is ${f.money(r.minimumCash.amount)}.`,
    ].join(' '),
    figures: [
      { label: 'Extra payroll a month', value: f.m(extra.toDecimalPlaces(input.scale)), unit: 'MONEY' },
      { label: 'Net profit, without the rise', value: b.totals.netProfit, unit: 'MONEY' },
      { label: 'Net profit, with the rise', value: r.totals.netProfit, unit: 'MONEY' },
      { label: 'Cash at the end, without', value: b.closingCash, unit: 'MONEY' },
      { label: 'Cash at the end, with', value: r.closingCash, unit: 'MONEY' },
      { label: 'Lowest cash, with', value: r.minimumCash.amount, unit: 'MONEY' },
    ],
    period: { from: b.months[0]?.month ?? '', to: b.months[h - 1]?.month ?? '', label: `${monthLabel(b.months[0].month)} to ${monthLabel(b.months[h - 1].month)}` },
    method: `The digital twin projects the average of the last ${input.base.baseline.monthsUsed} months forward, once as it is and once with payroll ${input.percent}% higher from the first month; the difference is the effect.`,
    assumptions: [...input.withRise.assumptions.slice(0, 3), 'Payroll taxes and contributions rise in the same proportion if they are booked as payroll.'],
    confidence: input.base.baseline.monthsUsed >= 6 ? 'MEDIUM' : 'LOW',
    confidenceReason: 'A projection of recent averages, not a forecast of new business.',
    sources: [SRC.twin, { label: 'Payroll', path: '/payroll' }],
    actions: [{ text: 'Open this as a twin scenario to refine it', path: `${SRC.twin.path}/new`, approval: 'Owner approval for a pay rise' }],
  });
}

export interface VendorLine {
  vendor: string;
  item: string;
  date: string;
  quantity: string;
  unitPrice: string;
}

/** Items whose unit price from a vendor rose by 5% or more: the last 90 days against the 9 months before. */
export function vendorPrices(input: { currency: string; scale: number; today: string; lines: VendorLine[] }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const cut = addDaysIso(input.today, -90);
  const groups = new Map<string, { vendor: string; item: string; recent: VendorLine[]; before: VendorLine[] }>();
  for (const l of input.lines) {
    const k = `${l.vendor}\u0000${l.item.trim().toLowerCase()}`;
    const g = groups.get(k) ?? { vendor: l.vendor, item: l.item.trim(), recent: [], before: [] };
    (l.date > cut ? g.recent : g.before).push(l);
    groups.set(k, g);
  }
  const avg = (ls: VendorLine[]) => {
    const q = sum(ls.map((l) => new D(l.quantity)));
    return q.isZero() ? null : sum(ls.map((l) => new D(l.quantity).times(l.unitPrice))).dividedBy(q);
  };
  const rows = [...groups.values()]
    .map((g) => {
      const [r, b] = [avg(g.recent), avg(g.before)];
      if (!r || !b || b.isZero()) return null;
      const qty = sum(g.recent.map((l) => new D(l.quantity)));
      return { vendor: g.vendor, item: g.item, before: b, recent: r, change: pct(r.minus(b), b), extra: r.minus(b).times(qty) };
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.change.greaterThanOrEqualTo(5))
    .sort((a, b) => b.extra.comparedTo(a.extra));
  const extra = sum(rows.map((x) => x.extra));
  return answer('VENDOR_PRICES', {
    area: 'COSTS',
    title: rows.length ? `${rows.length} price increase${rows.length === 1 ? '' : 's'} from vendors` : 'No vendor price increases found',
    verdict: rows.length ? 'WATCH' : 'GOOD',
    summary: rows.length
      ? `${rows.slice(0, 3).map((x) => `${x.vendor} charged ${f.money(x.recent.toDecimalPlaces(input.scale))} for ${x.item} against ${f.money(x.before.toDecimalPlaces(input.scale))} before (${f.pct(x.change)} more)`).join('; ')}. Together the increases cost ${f.money(extra.toDecimalPlaces(input.scale))} more in the last 90 days.`
      : 'No item was bought from the same vendor at a unit price 5% or more above what it cost in the 9 months before.',
    figures: [
      { label: 'Price increases found', value: String(rows.length), unit: 'COUNT' },
      { label: 'Extra cost, last 90 days', value: f.m(extra.toDecimalPlaces(input.scale)), unit: 'MONEY' },
    ],
    period: { from: addDaysIso(input.today, -365), to: input.today, label: 'Last 90 days against the 9 months before' },
    method: 'Bill lines grouped by vendor and item description. Average unit price (weighted by quantity) in the last 90 days against the 9 months before; listed when 5% or more higher. Extra cost = price difference × quantity bought in the last 90 days.',
    assumptions: ['Lines with the same description from the same vendor are the same item.', 'Bills in other currencies are compared in their own currency.'],
    confidence: rows.length ? 'MEDIUM' : 'LOW',
    confidenceReason: 'Depends on item descriptions being written the same way on each bill.',
    sources: [SRC.bills, SRC.ap],
    actions: rows.slice(0, 2).map((x) => ({ text: `Ask ${x.vendor} about the ${x.item} price`, path: SRC.bills.path, approval: null })),
    table: {
      columns: [{ key: 'vendor', label: 'Vendor', unit: 'TEXT' }, { key: 'item', label: 'Item', unit: 'TEXT' }, { key: 'before', label: 'Unit price before', unit: 'MONEY' }, { key: 'recent', label: 'Unit price, last 90 days', unit: 'MONEY' }, { key: 'change', label: 'Change', unit: 'PERCENT' }, { key: 'extra', label: 'Extra cost', unit: 'MONEY' }],
      rows: rows.map((x) => ({ vendor: x.vendor, item: x.item, before: x.before.toFixed(input.scale), recent: x.recent.toFixed(input.scale), change: p1(x.change), extra: x.extra.toFixed(input.scale) })),
    },
  });
}

/** Tax owed per the ledger (tax payable accounts) and statutory items overdue or due soon. */
export function taxExposure(input: Pick<CfoInput, 'compliance' | 'currency' | 'scale' | 'today'> & { payable: { code: string; name: string; balance: string }[] }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const owed = sum(input.payable.map((p) => new D(p.balance)));
  const overdue = input.compliance.filter((c) => c.status === 'OVERDUE');
  const soon = input.compliance.filter((c) => c.status !== 'OVERDUE');
  const due = (xs: typeof input.compliance) => sum(xs.map((c) => new D(c.amount ?? 0)));
  return answer('TAX_EXPOSURE', {
    area: 'RISK',
    title: `${f.money(owed)} of tax is owed per the ledger`,
    verdict: overdue.length ? 'ACT' : soon.length ? 'WATCH' : 'GOOD',
    summary: [
      `Tax payable accounts show ${f.money(owed)} owed${input.payable.length ? ` (${input.payable.filter((p) => !new D(p.balance).isZero()).slice(0, 3).map((p) => `${p.name} ${f.money(p.balance)}`).join(', ')})` : ''}.`,
      overdue.length ? `${overdue.length} filing or payment is overdue${due(overdue).greaterThan(0) ? `, with ${f.money(due(overdue))} still to pay` : ''}, which can attract interest and late fees.`.replace('payment is overdue', overdue.length === 1 ? 'payment is overdue' : 'payments are overdue') : 'Nothing is overdue.',
      soon.length ? `${soon.length} more fall due in the next 45 days.` : '',
    ]
      .filter(Boolean)
      .join(' '),
    figures: [
      { label: 'Tax owed per the ledger', value: f.m(owed), unit: 'MONEY' },
      { label: 'Overdue items', value: String(overdue.length), unit: 'COUNT' },
      { label: 'Overdue amount', value: f.m(due(overdue)), unit: 'MONEY' },
      { label: 'Due in the next 45 days', value: String(soon.length), unit: 'COUNT' },
    ],
    period: { from: input.today, to: addDaysIso(input.today, 45), label: `Balances at ${formatDateText(input.today)}, items due in the next 45 days` },
    method: 'Balances of the liability accounts with the Tax payable subtype (GST, TDS, TCS and similar), plus filings and payments from the compliance calendar that are overdue or due in the next 45 days.',
    assumptions: ['Income tax for the year is only included if a provision has been posted.', 'Interest and penalties are not estimated.'],
    confidence: 'MEDIUM',
    confidenceReason: 'Ledger balances are exact; whether all tax has been booked depends on the books being up to date. Confirm filing positions with your chartered accountant.',
    sources: [SRC.compliance, { label: 'GST returns', path: '/tax/gst-returns' }, { label: 'Trial balance', path: '/reports/trial-balance' }],
    actions: overdue.length ? [{ text: 'File or pay the overdue items', path: SRC.compliance.path, approval: 'The person responsible for filings' }] : soon.length ? [{ text: 'Plan the payments due in the next 45 days', path: SRC.compliance.path, approval: null }] : [],
    table: {
      columns: [{ key: 'item', label: 'Item', unit: 'TEXT' }, { key: 'due', label: 'Due', unit: 'TEXT' }, { key: 'status', label: 'Status', unit: 'TEXT' }, { key: 'amount', label: 'Amount', unit: 'MONEY' }],
      rows: [...input.payable.filter((p) => !new D(p.balance).isZero()).map((p) => ({ item: `${p.code} ${p.name} (ledger balance)`, due: null, status: null, amount: p.balance })), ...input.compliance.map((c) => ({ item: c.name, due: formatDateText(c.dueDate), status: c.status === 'OVERDUE' ? 'Overdue' : c.status === 'DUE_SOON' ? 'Due soon' : 'Upcoming', amount: c.amount }))],
    },
  });
}

export interface OpenInvoiceRisk {
  number: string;
  customer: string;
  dueDate: string;
  balance: string;
  averageDaysLate: number | null;
  paidInvoices: number;
}

/** Open invoices likely to be paid late, from each customer's record of paying in the last 12 months. */
export function lateInvoices(input: { currency: string; scale: number; today: string; invoices: OpenInvoiceRisk[] }): CfoAnswer {
  const f = new Fmt(input.currency, input.scale);
  const rows = input.invoices
    .map((i) => {
      const overdueDays = Math.max(0, daysBetweenIso(i.dueDate, input.today));
      const late = i.averageDaysLate ?? 0;
      const level = overdueDays > 30 || late > 30 ? 'HIGH' : overdueDays > 0 || late > 7 ? 'MEDIUM' : 'LOW';
      const expected = addDaysIso(i.dueDate, Math.max(0, late));
      return { ...i, overdueDays, level, expected: expected < input.today ? input.today : expected };
    })
    .filter((x) => x.level !== 'LOW')
    .sort((a, b) => (a.level === b.level ? new D(b.balance).comparedTo(a.balance) : a.level === 'HIGH' ? -1 : 1));
  const tot = sum(rows.map((r) => new D(r.balance)));
  const thin = input.invoices.filter((i) => i.paidInvoices < 3).length;
  return answer('LATE_INVOICES', {
    area: 'WORKING_CAPITAL',
    title: rows.length ? `${rows.length} invoice${rows.length === 1 ? ' is' : 's are'} likely to be paid late` : 'No invoice looks likely to be paid late',
    verdict: rows.some((r) => r.level === 'HIGH') ? 'ACT' : rows.length ? 'WATCH' : 'GOOD',
    summary: rows.length
      ? `${f.money(tot)} across ${rows.length} open invoice${rows.length === 1 ? '' : 's'}: ${rows.slice(0, 3).map((r) => `${r.number} to ${r.customer} (${f.money(r.balance)}, ${r.overdueDays ? `${r.overdueDays} days overdue` : `due ${formatDateText(r.dueDate)}`}${r.averageDaysLate !== null ? `, usually pays ${r.averageDaysLate} days late` : ''})`).join('; ')}.`
      : 'Every open invoice is either not yet due from a customer who pays on time, or there is nothing open.',
    figures: [
      { label: 'Invoices likely late', value: String(rows.length), unit: 'COUNT' },
      { label: 'Amount', value: f.m(tot), unit: 'MONEY' },
      { label: 'High risk', value: String(rows.filter((r) => r.level === 'HIGH').length), unit: 'COUNT' },
    ],
    period: { from: addDaysIso(input.today, -365), to: input.today, label: `Open at ${formatDateText(input.today)}, history of the last 12 months` },
    method: 'High risk: more than 30 days overdue, or the customer paid more than 30 days late on average in the last 12 months. Medium: already overdue, or usually more than 7 days late. Expected payment = due date + the customer’s average days late.',
    assumptions: ['A customer’s past behaviour is the best guide available; it does not know about disputes or one-off problems.'],
    confidence: thin > input.invoices.length / 2 ? 'LOW' : 'MEDIUM',
    confidenceReason: thin ? `${thin} of the open invoices are to customers with fewer than three paid invoices to learn from.` : 'Every customer has some payment history.',
    sources: [SRC.ar, { label: 'Collections', path: '/sales/collections' }],
    actions: rows.length ? [{ text: 'Draft reminders for these customers', path: '/sales/collections', approval: 'A person reviews and sends each reminder' }] : [],
    table: {
      columns: [{ key: 'risk', label: 'Risk', unit: 'TEXT' }, { key: 'invoice', label: 'Invoice', unit: 'TEXT' }, { key: 'customer', label: 'Customer', unit: 'TEXT' }, { key: 'due', label: 'Due', unit: 'TEXT' }, { key: 'balance', label: 'To pay', unit: 'MONEY' }, { key: 'late', label: 'Usually late by', unit: 'DAYS' }, { key: 'expected', label: 'Expected', unit: 'TEXT' }],
      rows: rows.map((r) => ({ risk: r.level === 'HIGH' ? 'High' : 'Medium', invoice: r.number, customer: r.customer, due: formatDateText(r.dueDate), balance: r.balance, late: r.averageDaysLate, expected: formatDateText(r.expected) })),
    },
  });
}

function addDaysIso(d: string, n: number) {
  return new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function daysBetweenIso(a: string, b: string) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ------------------------------------------------------------------ AI summaries: facts in, figures checked

const fmtFigure = (x: CfoFigure, f: Fmt) => (x.value === null ? 'n/a' : x.unit === 'MONEY' ? f.money(x.value) : x.unit === 'PERCENT' ? `${x.value}%` : x.unit === 'DAYS' ? `${x.value} days` : x.unit === 'MONTHS' ? `${x.value} months` : x.value);

/** The facts an AI summary may use, as plain text. Every figure the summary quotes must appear here. */
export function factsForSummary(a: CfoAssessment, scale: number, extra: string[] = []): string {
  const f = new Fmt(a.currency, scale);
  const lines = [`Figures at ${formatDateText(a.asOf)} (last complete month ${monthLabel(a.lastMonth)}), currency ${a.currency}.`, `Financial health score: ${a.health.score} out of 100 (${a.health.grade.toLowerCase()}).`];
  for (const c of a.health.components) lines.push(`- ${c.label}: ${c.points} of ${c.max} points. ${c.reason}`);
  for (const x of a.findings) {
    lines.push('', `${x.title} [${x.verdict}] (${x.period.label}): ${x.summary}`);
    for (const fig of x.figures) if (fig.value !== null) lines.push(`- ${fig.label}: ${fmtFigure(fig, f)}`);
    if (x.table) for (const r of x.table.rows.slice(0, 5)) lines.push(`- ${Object.values(r).filter((v) => v !== null).join(' | ')}`);
  }
  if (a.recommendations.length) lines.push('', 'Recommended actions:', ...a.recommendations.map((r) => `- ${r.text}${r.approval ? ` (needs: ${r.approval})` : ''}`));
  if (extra.length) lines.push('', ...extra);
  return lines.join('\n');
}

const NUMBER = /(?<![\w.])[-−]?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d+)?(?![\w])/g;
const norm = (s: string) => s.replace(/[−]/g, '-').replace(/,/g, '').replace(/^-/, '');
const trimZeros = (n: string) => (n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n);
function numbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map(norm);
}

/**
 * The figures in a summary that are not in the facts it was written from. Small whole numbers
 * (counts, months up to 12, list numbering) are allowed; every other number must appear in the
 * facts exactly, or as the same value with trailing zeros dropped (₹1,20,000.00 written ₹1,20,000).
 */
export function checkSummaryFigures(summary: string, facts: string): string[] {
  const allowed = new Set<string>();
  for (const n of numbers(facts)) {
    allowed.add(n);
    allowed.add(trimZeros(n));
  }
  const bad = new Set<string>();
  for (const n of numbers(summary)) {
    if (/^\d+$/.test(n) && +n <= 12) continue;
    if (!allowed.has(n) && !allowed.has(trimZeros(n))) bad.add(n);
  }
  return [...bad];
}
