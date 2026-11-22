/**
 * Executive and investor reports (RPT-022, RPT-023): one report for a fiscal quarter or a fiscal
 * year, from posted journals grouped into month figures (see kpis.ts).
 *
 * - Headline: revenue, gross profit and margin, operating profit, net income and margin, cash at the
 *   start and end, the average monthly change in cash, runway (cash ÷ average monthly outflow, only
 *   when cash fell), receivables and payables at the end.
 * - Profit and loss against the period before (the quarter before, or the year before) and the same
 *   period last year, with the change in percent.
 * - Month by month: revenue, gross profit, net income and cash.
 * - Customers: an executive report names the largest customers; an investor report shows only how
 *   concentrated revenue is, never a customer's name.
 * - Points for attention (executive only): a net loss, revenue down 10% or more on the period before,
 *   gross margin down 5 points or more, runway under 12 months (under 6 is high), and one customer
 *   with 30% or more of revenue.
 */
import Decimal from 'decimal.js';
import { addPl, concentration, type MonthFigures, PL_LINES, type PlFigures, plFigures, zeroPl } from './kpis';
import { D, type Dec } from './money';

export const STAKEHOLDER_AUDIENCES = ['EXECUTIVE', 'INVESTOR'] as const;
export type StakeholderAudience = (typeof STAKEHOLDER_AUDIENCES)[number];
export const REVENUE_DROP_PERCENT = '10';
export const MARGIN_DROP_POINTS = '5';
export const SHORT_RUNWAY_MONTHS = '12';
export const CONCENTRATION_PERCENT = '30';

const PERIOD = /^FY(\d{4})(?:-Q([1-4]))?$/;

const shift = (month: string, by: number) => {
  const m = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by; // not money
  return `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => `${month}-${String(new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate()).padStart(2, '0')}`;

/** The name of a fiscal year: "FY 2026" for a calendar year, "FY 2026-27" otherwise. */
function fyLabel(fy: number, startMonth: number): string {
  return startMonth === 1 ? `FY ${fy}` : `FY ${fy - 1}-${String(fy % 100).padStart(2, '0')}`; // not money
}

export interface ReportPeriod {
  key: string;
  label: string;
  kind: 'QUARTER' | 'YEAR';
  fiscalYear: number;
  quarter: number | null;
  months: string[];
  from: string;
  to: string;
  /** The quarter before, or the year before. */
  prior: string;
  /** The same quarter, or the year, a year earlier. */
  lastYear: string;
}

/** A period key ("FY2027" or "FY2027-Q2") read against the fiscal year's first month; null if malformed. */
export function reportPeriod(key: string, startMonth: number): ReportPeriod | null {
  const m = PERIOD.exec(key);
  if (!m) return null;
  const fy = +m[1]!;
  const q = m[2] ? +m[2] : null;
  const fyStart = `${startMonth === 1 ? fy : fy - 1}-${String(startMonth).padStart(2, '0')}`;
  const first = q ? shift(fyStart, (q - 1) * 3) : fyStart; // not money
  const months = Array.from({ length: q ? 3 : 12 }, (_, i) => shift(first, i));
  const prior = q ? (q === 1 ? `FY${fy - 1}-Q4` : `FY${fy}-Q${q - 1}`) : `FY${fy - 1}`;
  return {
    key,
    label: q ? `Q${q} ${fyLabel(fy, startMonth)}` : fyLabel(fy, startMonth),
    kind: q ? 'QUARTER' : 'YEAR',
    fiscalYear: fy,
    quarter: q,
    months,
    from: `${months[0]}-01`,
    to: lastDay(months[months.length - 1]!),
    prior,
    lastYear: q ? `FY${fy - 1}-Q${q}` : `FY${fy - 1}`,
  };
}

/** The period that contains a date. */
export function periodFor(date: string, startMonth: number, kind: 'QUARTER' | 'YEAR'): string {
  const month = +date.slice(5, 7);
  const fy = startMonth === 1 ? +date.slice(0, 4) : month >= startMonth ? +date.slice(0, 4) + 1 : +date.slice(0, 4);
  if (kind === 'YEAR') return `FY${fy}`;
  const offset = (month - startMonth + 12) % 12; // not money
  return `FY${fy}-Q${Math.floor(offset / 3) + 1}`; // not money
}

/** The months to fetch figures for: from the same period last year to the period's end. */
export function reportMonthsNeeded(p: ReportPeriod, startMonth: number): string[] {
  const ly = reportPeriod(p.lastYear, startMonth)!;
  const pr = reportPeriod(p.prior, startMonth)!;
  const first = [ly.months[0]!, pr.months[0]!].sort()[0]!;
  const out: string[] = [];
  for (let m = first; m <= p.months[p.months.length - 1]!; m = shift(m, 1)) out.push(m);
  return out;
}

const pct = (x: Dec, of: Dec) => (of.isZero() ? null : x.dividedBy(of).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toFixed(1));
const growth = (now: Dec, before: Dec) => (before.isZero() ? null : now.minus(before).dividedBy(before.abs()).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toFixed(1));

export interface StakeholderReportInput {
  audience: StakeholderAudience;
  period: ReportPeriod;
  prior: ReportPeriod;
  lastYear: ReportPeriod;
  /** Month figures covering at least the three periods; missing months count as nothing posted. */
  figures: readonly MonthFigures[];
  /** Revenue by customer in the period (see concentration). */
  customers: ReturnType<typeof concentration>;
  scale: number;
}

export function buildStakeholderReport(i: StakeholderReportInput) {
  const f = (x: Dec) => x.toFixed(i.scale);
  const byMonth = new Map(i.figures.map((m) => [m.month, m]));
  const pl = (p: ReportPeriod) => p.months.map((m) => (byMonth.has(m) ? plFigures(byMonth.get(m)!) : zeroPl())).reduce(addPl, zeroPl());
  const now = pl(i.period);
  const before = pl(i.prior);
  const ly = pl(i.lastYear);
  const inPeriod = i.period.months.map((m) => byMonth.get(m)).filter((m): m is MonthFigures => !!m);
  const end = inPeriod[inPeriod.length - 1];
  const closing = end?.cash ?? new D(0);
  const change = inPeriod.reduce((a, m) => a.plus(m.cashChange), new D(0));
  const opening = closing.minus(change);
  const averageChange = inPeriod.length ? change.dividedBy(inPeriod.length) : new D(0);
  const runway = averageChange.lessThan(0) && closing.greaterThan(0) ? closing.dividedBy(averageChange.negated()).toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN) : null;
  const margin = (p: PlFigures) => pct(p.grossProfit, p.operatingRevenue);
  const headline = {
    revenue: f(now.operatingRevenue),
    revenueGrowthPrior: growth(now.operatingRevenue, before.operatingRevenue),
    revenueGrowthYear: growth(now.operatingRevenue, ly.operatingRevenue),
    grossProfit: f(now.grossProfit),
    grossMargin: margin(now),
    grossMarginPrior: margin(before),
    operatingProfit: f(now.operatingProfit),
    netIncome: f(now.netIncome),
    netMargin: pct(now.netIncome, now.operatingRevenue.plus(now.otherIncome)),
    cashOpening: f(opening),
    cashClosing: f(closing),
    cashChange: f(change),
    averageMonthlyCashChange: f(averageChange.toDecimalPlaces(i.scale, Decimal.ROUND_HALF_EVEN)),
    runwayMonths: runway ? runway.toFixed(1) : null,
    receivables: f(end?.receivables ?? new D(0)),
    payables: f(end?.payables ?? new D(0)),
  };
  const lines = PL_LINES.map((l) => ({
    key: l.key,
    label: l.label,
    kind: l.kind,
    current: f(now[l.key]),
    prior: f(before[l.key]),
    lastYear: f(ly[l.key]),
    changePrior: growth(now[l.key], before[l.key]),
    changeYear: growth(now[l.key], ly[l.key]),
  }));
  const months = i.period.months.map((m) => {
    const x = byMonth.get(m);
    const p = x ? plFigures(x) : zeroPl();
    return { month: m, revenue: f(p.operatingRevenue), grossProfit: f(p.grossProfit), netIncome: f(p.netIncome), cash: x ? f(x.cash) : null };
  });

  const attention: { code: string; severity: 'HIGH' | 'MEDIUM'; message: string }[] = [];
  if (i.audience === 'EXECUTIVE') {
    if (now.netIncome.lessThan(0)) attention.push({ code: 'NET_LOSS', severity: 'HIGH', message: `A net loss of ${f(now.netIncome.negated())} in ${i.period.label}` });
    const g = headline.revenueGrowthPrior;
    if (g !== null && new D(g).lessThanOrEqualTo(new D(REVENUE_DROP_PERCENT).negated())) attention.push({ code: 'REVENUE_DOWN', severity: 'MEDIUM', message: `Revenue fell ${new D(g).negated().toFixed(1)}% on ${i.prior.label}` });
    if (headline.grossMargin !== null && headline.grossMarginPrior !== null) {
      const drop = new D(headline.grossMarginPrior).minus(headline.grossMargin);
      if (drop.greaterThanOrEqualTo(MARGIN_DROP_POINTS)) attention.push({ code: 'MARGIN_DOWN', severity: 'MEDIUM', message: `Gross margin fell ${drop.toFixed(1)} points, from ${headline.grossMarginPrior}% to ${headline.grossMargin}%` });
    }
    if (runway && runway.lessThan(SHORT_RUNWAY_MONTHS)) attention.push({ code: 'SHORT_RUNWAY', severity: runway.lessThan(6) ? 'HIGH' : 'MEDIUM', message: `Cash lasts about ${runway.toFixed(1)} months at the period's average outflow` });
    if (i.customers.largestShare !== null && new D(i.customers.largestShare).greaterThanOrEqualTo(CONCENTRATION_PERCENT)) attention.push({ code: 'CONCENTRATION', severity: 'MEDIUM', message: `${i.customers.top[0]!.name} brought ${i.customers.largestShare}% of revenue` });
    attention.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'HIGH' ? -1 : 1));
  }
  const customers =
    i.audience === 'EXECUTIVE'
      ? { count: i.customers.customers, largestShare: i.customers.largestShare, topFiveShare: i.customers.topFiveShare, top: i.customers.top.map((c) => ({ name: c.name, revenue: c.revenue, share: c.share })) }
      : { count: i.customers.customers, largestShare: i.customers.largestShare, topFiveShare: i.customers.topFiveShare, top: [] as { name: string; revenue: string; share: string | null }[] };

  return {
    audience: i.audience,
    period: { key: i.period.key, label: i.period.label, from: i.period.from, to: i.period.to },
    prior: { key: i.prior.key, label: i.prior.label },
    lastYear: { key: i.lastYear.key, label: i.lastYear.label },
    headline,
    lines,
    months,
    customers,
    attention,
  };
}

export type StakeholderReport = ReturnType<typeof buildStakeholderReport>;
