/**
 * Privacy-preserving financial benchmarking.
 *
 * Each participating organisation contributes ten ratios worked out from its own posted books
 * (never amounts, names or records). A comparison shows only aggregates of other participants:
 * the median once at least {@link MIN_PEERS} others have a value, and the quartiles once at least
 * {@link MIN_PEERS_FOR_QUARTILES} do. Smaller groups are suppressed and the next broader peer group
 * is tried. No floating point.
 */
import Decimal from 'decimal.js';
import type { MonthFigures } from './kpis';
import { D, Dec, sum } from './money';

export type BenchmarkMetricKey =
  | 'GROSS_MARGIN'
  | 'NET_MARGIN'
  | 'REVENUE_GROWTH'
  | 'OPEX_RATIO'
  | 'DSO'
  | 'DPO'
  | 'WORKING_CAPITAL_DAYS'
  | 'REVENUE_PER_EMPLOYEE'
  | 'PROJECT_MARGIN'
  | 'CASH_CONVERSION_CYCLE';

export type BenchmarkUnit = 'PERCENT' | 'DAYS' | 'MONEY';

export interface BenchmarkMetricDefinition {
  key: BenchmarkMetricKey;
  label: string;
  unit: BenchmarkUnit;
  better: 'HIGHER' | 'LOWER';
  formula: string;
}

/** Fewest other participants with a value before the median is shown. */
export const MIN_PEERS = 5;
/** Fewest other participants with a value before the quartiles are shown as well. */
export const MIN_PEERS_FOR_QUARTILES = 10;

export const BENCHMARK_METRICS: readonly BenchmarkMetricDefinition[] = [
  { key: 'GROSS_MARGIN', label: 'Gross margin', unit: 'PERCENT', better: 'HIGHER', formula: '(Revenue − cost of sales) ÷ revenue, over the last 12 months.' },
  { key: 'NET_MARGIN', label: 'Net margin', unit: 'PERCENT', better: 'HIGHER', formula: 'Net income ÷ (revenue + other income), over the last 12 months.' },
  { key: 'REVENUE_GROWTH', label: 'Revenue growth', unit: 'PERCENT', better: 'HIGHER', formula: 'Revenue of the last 12 months against the 12 months before.' },
  { key: 'OPEX_RATIO', label: 'Operating expense ratio', unit: 'PERCENT', better: 'LOWER', formula: 'Operating expenses, payroll and depreciation ÷ revenue, over the last 12 months.' },
  { key: 'DSO', label: 'Days sales outstanding', unit: 'DAYS', better: 'LOWER', formula: 'Receivables at the month end ÷ revenue of the last 3 months × days in those months.' },
  { key: 'DPO', label: 'Days payables outstanding', unit: 'DAYS', better: 'HIGHER', formula: 'Payables at the month end ÷ (cost of sales + operating expenses without payroll and depreciation) of the last 3 months × days in those months.' },
  { key: 'WORKING_CAPITAL_DAYS', label: 'Working capital efficiency', unit: 'DAYS', better: 'LOWER', formula: '(Receivables + inventory − payables) at the month end ÷ revenue of the last 12 months × 365: days of sales tied up in working capital.' },
  { key: 'REVENUE_PER_EMPLOYEE', label: 'Revenue per employee', unit: 'MONEY', better: 'HIGHER', formula: 'Revenue of the last 12 months ÷ headcount at the month end. Compared only with participants in the same currency.' },
  { key: 'PROJECT_MARGIN', label: 'Project profitability', unit: 'PERCENT', better: 'HIGHER', formula: 'Profit before overheads of all projects ÷ their revenue, over the last 12 months. Only when lines are tagged with projects.' },
  { key: 'CASH_CONVERSION_CYCLE', label: 'Cash conversion cycle', unit: 'DAYS', better: 'LOWER', formula: 'Days sales outstanding + days inventory (inventory ÷ cost of sales of the last 3 months × days) − days payables outstanding.' },
];

export const BENCHMARK_INDUSTRIES = [
  { key: 'RETAIL', label: 'Retail' },
  { key: 'WHOLESALE', label: 'Wholesale and distribution' },
  { key: 'MANUFACTURING', label: 'Manufacturing' },
  { key: 'PROFESSIONAL_SERVICES', label: 'Professional services' },
  { key: 'SOFTWARE', label: 'Software and IT services' },
  { key: 'LOGISTICS', label: 'Transport and logistics' },
  { key: 'CONSTRUCTION', label: 'Construction and real estate' },
  { key: 'HOSPITALITY', label: 'Hospitality and food' },
  { key: 'HEALTHCARE', label: 'Healthcare' },
  { key: 'EDUCATION', label: 'Education' },
  { key: 'OTHER', label: 'Other' },
] as const;
export type BenchmarkIndustry = (typeof BENCHMARK_INDUSTRIES)[number]['key'];

export const BENCHMARK_SIZE_BANDS = [
  { key: 'MICRO', label: '1 to 10 people' },
  { key: 'SMALL', label: '11 to 50 people' },
  { key: 'MEDIUM', label: '51 to 250 people' },
  { key: 'LARGE', label: 'More than 250 people' },
] as const;
export type BenchmarkSizeBand = (typeof BENCHMARK_SIZE_BANDS)[number]['key'];

export function sizeBandFor(headcount: number): BenchmarkSizeBand {
  if (headcount <= 10) return 'MICRO';
  if (headcount <= 50) return 'SMALL';
  if (headcount <= 250) return 'MEDIUM';
  return 'LARGE';
}

const PLACES: Record<BenchmarkUnit, number> = { PERCENT: 1, DAYS: 0, MONEY: 0 };
const round = (x: Dec, unit: BenchmarkUnit) => x.toDecimalPlaces(PLACES[unit], Decimal.ROUND_HALF_EVEN).toFixed(PLACES[unit]);
const unitOf = (k: BenchmarkMetricKey) => BENCHMARK_METRICS.find((m) => m.key === k)!.unit;

export interface BenchmarkInput {
  /** Monthly figures, chronological, ending with the last complete month. Up to 24 are used. */
  months: readonly MonthFigures[];
  /** People employed at the end of the last month, or null when not known. */
  headcount: number | null;
  /** Revenue and profit before overheads of lines tagged with a project, last 12 months. */
  projects: { revenue: string; net: string } | null;
}

export interface BenchmarkMetricValue {
  key: BenchmarkMetricKey;
  /** Rounded: percentages to 1 place, days and money to whole units. Null when it cannot be worked out. */
  value: string | null;
  reason: string | null;
  /** What it was worked out from (this organisation's own figures; never shared). */
  components: { label: string; amount: string }[];
}

/** The ten metrics for the last month of `input.months`. */
export function benchmarkMetrics(input: BenchmarkInput, scale = 2): BenchmarkMetricValue[] {
  const ms = input.months;
  if (!ms.length) throw new Error('No months');
  const m = ms[ms.length - 1]!;
  const last12 = ms.slice(-12);
  const prev12 = ms.length >= 24 ? ms.slice(-24, -12) : [];
  const last3 = ms.slice(-3);
  const money = (x: Dec) => x.toFixed(scale);
  const pct = (a: Dec, b: Dec) => a.dividedBy(b).times(100);
  const v = (key: BenchmarkMetricKey, value: Dec | null, reason: string, components: [string, Dec][]): BenchmarkMetricValue => ({
    key,
    value: value === null ? null : round(value, unitOf(key)),
    reason: value === null ? reason : null,
    components: components.map(([label, amount]) => ({ label, amount: money(amount) })),
  });

  const rev12 = sum(last12.map((x) => x.operatingRevenue));
  const other12 = sum(last12.map((x) => x.otherIncome));
  const cos12 = sum(last12.map((x) => x.costOfSales));
  const opex12 = sum(last12.map((x) => x.operatingExpenses));
  const below12 = sum(last12.map((x) => x.interest.plus(x.incomeTax).plus(x.otherExpenses)));
  const net12 = rev12.plus(other12).minus(cos12).minus(opex12).minus(below12);
  const revPrev = sum(prev12.map((x) => x.operatingRevenue));
  const days3 = last3.reduce((a, x) => a + x.days, 0);
  const rev3 = sum(last3.map((x) => x.operatingRevenue));
  const cos3 = sum(last3.map((x) => x.costOfSales));
  const spend3 = sum(last3.map((x) => x.costOfSales.plus(x.operatingExpenses).minus(x.payroll).minus(x.depreciation)));
  const noRev = 'No revenue in the last 12 months';
  const short = last12.length < 12 ? ` (only ${last12.length} months of books)` : '';

  const dso = rev3.greaterThan(0) ? m.receivables.dividedBy(rev3).times(days3) : null;
  const dpo = spend3.greaterThan(0) ? m.payables.dividedBy(spend3).times(days3) : null;
  const dio = cos3.greaterThan(0) ? m.inventory.dividedBy(cos3).times(days3) : m.inventory.isZero() ? new D(0) : null;
  const ccc = dso !== null && dpo !== null && dio !== null ? dso.plus(dio).minus(dpo) : null;
  const wc = m.receivables.plus(m.inventory).minus(m.payables);
  const proj = input.projects;
  const projRev = proj ? new D(proj.revenue) : new D(0);

  return [
    v('GROSS_MARGIN', rev12.greaterThan(0) ? pct(rev12.minus(cos12), rev12) : null, noRev, [['Revenue, last 12 months' + short, rev12], ['Cost of sales', cos12]]),
    v('NET_MARGIN', rev12.plus(other12).greaterThan(0) ? pct(net12, rev12.plus(other12)) : null, noRev, [['Revenue and other income, last 12 months' + short, rev12.plus(other12)], ['Net income', net12]]),
    v(
      'REVENUE_GROWTH',
      prev12.length === 12 && revPrev.greaterThan(0) ? pct(rev12.minus(revPrev), revPrev) : null,
      prev12.length < 12 ? 'Needs 24 months of books' : 'No revenue in the 12 months before',
      [['Revenue, last 12 months', rev12], ['Revenue, 12 months before', revPrev]],
    ),
    v('OPEX_RATIO', rev12.greaterThan(0) ? pct(opex12, rev12) : null, noRev, [['Operating expenses, payroll and depreciation, last 12 months', opex12], ['Revenue', rev12]]),
    v('DSO', dso, 'No revenue in the last 3 months', [['Receivables at the month end', m.receivables], ['Revenue, last 3 months', rev3]]),
    v('DPO', dpo, 'No purchases or expenses in the last 3 months', [['Payables at the month end', m.payables], ['Cost of sales and operating expenses, last 3 months', spend3]]),
    v('WORKING_CAPITAL_DAYS', rev12.greaterThan(0) ? wc.dividedBy(rev12).times(365) : null, noRev, [['Receivables', m.receivables], ['Inventory', m.inventory], ['Payables', m.payables], ['Revenue, last 12 months', rev12]]),
    v(
      'REVENUE_PER_EMPLOYEE',
      input.headcount && input.headcount > 0 && rev12.greaterThan(0) ? rev12.dividedBy(input.headcount) : null,
      !input.headcount ? 'Headcount not known: add employees in payroll or enter it when you join' : noRev,
      [['Revenue, last 12 months', rev12], ['Headcount', new D(input.headcount ?? 0)]],
    ),
    v(
      'PROJECT_MARGIN',
      proj && projRev.greaterThan(0) ? pct(new D(proj.net), projRev) : null,
      'No revenue tagged with a project in the last 12 months',
      [['Project revenue, last 12 months', projRev], ['Project profit before overheads', new D(proj?.net ?? 0)]],
    ),
    v('CASH_CONVERSION_CYCLE', ccc, 'Needs revenue, purchases and (if there is inventory) cost of sales in the last 3 months', [['Days sales outstanding', dso ?? new D(0)], ['Days inventory', dio ?? new D(0)], ['Days payables outstanding', dpo ?? new D(0)]]),
  ];
}

/** Linear-interpolation percentile (the "type 7" definition) of sorted values. */
function percentile(sorted: readonly Dec[], p: number): Dec {
  const h = new D(sorted.length - 1).times(p);
  const lo = h.floor().toNumber();
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]!.plus(sorted[hi]!.minus(sorted[lo]!).times(h.minus(lo)));
}

export interface PeerAggregate {
  /** How many other participants had a value, as a band (never an exact count). */
  peers: '5 to 9' | '10 to 24' | '25 or more';
  median: string;
  /** Only when at least {@link MIN_PEERS_FOR_QUARTILES} others have a value. */
  lowerQuartile: string | null;
  upperQuartile: string | null;
}

/** Median and quartiles of peers' values, or null when there are too few to show anything. */
export function aggregatePeers(key: BenchmarkMetricKey, values: readonly string[]): PeerAggregate | null {
  if (values.length < MIN_PEERS) return null;
  const unit = unitOf(key);
  const sorted = values.map((x) => new D(x)).sort((a, b) => a.comparedTo(b));
  const quartiles = values.length >= MIN_PEERS_FOR_QUARTILES;
  return {
    peers: values.length >= 25 ? '25 or more' : values.length >= 10 ? '10 to 24' : '5 to 9',
    median: round(percentile(sorted, 0.5), unit),
    lowerQuartile: quartiles ? round(percentile(sorted, 0.25), unit) : null,
    upperQuartile: quartiles ? round(percentile(sorted, 0.75), unit) : null,
  };
}

export type BenchmarkPosition = 'TOP_QUARTER' | 'ABOVE_MEDIAN' | 'AT_MEDIAN' | 'BELOW_MEDIAN' | 'BOTTOM_QUARTER';

/** Where a value sits against the aggregate, with "better" taking the metric's direction into account. */
export function benchmarkPosition(key: BenchmarkMetricKey, value: string, agg: PeerAggregate): BenchmarkPosition {
  const better = BENCHMARK_METRICS.find((m) => m.key === key)!.better;
  const sign = better === 'HIGHER' ? 1 : -1;
  const x = new D(value);
  const cmp = (y: string) => x.comparedTo(new D(y)) * sign;
  const best = better === 'HIGHER' ? agg.upperQuartile : agg.lowerQuartile;
  const worst = better === 'HIGHER' ? agg.lowerQuartile : agg.upperQuartile;
  if (best !== null && cmp(best) >= 0 && cmp(agg.median) > 0) return 'TOP_QUARTER';
  if (worst !== null && cmp(worst) <= 0 && cmp(agg.median) < 0) return 'BOTTOM_QUARTER';
  const c = cmp(agg.median);
  return c > 0 ? 'ABOVE_MEDIAN' : c < 0 ? 'BELOW_MEDIAN' : 'AT_MEDIAN';
}

export interface PeerProfile {
  industry: BenchmarkIndustry;
  sizeBand: BenchmarkSizeBand;
  countryCode: string;
  currency: string;
}
export interface PeerContribution extends PeerProfile {
  metrics: Partial<Record<BenchmarkMetricKey, string>>;
}

export type PeerGroupLevel = 'INDUSTRY_SIZE_COUNTRY' | 'INDUSTRY_SIZE' | 'INDUSTRY' | 'ALL';
export const PEER_GROUP_LEVELS: readonly { key: PeerGroupLevel; label: (p: PeerProfile) => string; match: (a: PeerProfile, b: PeerProfile) => boolean }[] = [
  { key: 'INDUSTRY_SIZE_COUNTRY', label: (p) => `${industryLabel(p.industry)}, ${sizeLabel(p.sizeBand)}, ${p.countryCode}`, match: (a, b) => a.industry === b.industry && a.sizeBand === b.sizeBand && a.countryCode === b.countryCode },
  { key: 'INDUSTRY_SIZE', label: (p) => `${industryLabel(p.industry)}, ${sizeLabel(p.sizeBand)}, any country`, match: (a, b) => a.industry === b.industry && a.sizeBand === b.sizeBand },
  { key: 'INDUSTRY', label: (p) => `${industryLabel(p.industry)}, any size or country`, match: (a, b) => a.industry === b.industry },
  { key: 'ALL', label: () => 'All participants', match: () => true },
];
export const industryLabel = (k: string) => BENCHMARK_INDUSTRIES.find((i) => i.key === k)?.label ?? k;
export const sizeLabel = (k: string) => BENCHMARK_SIZE_BANDS.find((s) => s.key === k)?.label ?? k;

export interface BenchmarkComparison {
  key: BenchmarkMetricKey;
  value: string | null;
  /** The narrowest peer group with enough participants, or null when every group was too small. */
  group: { level: PeerGroupLevel; label: string } | null;
  aggregate: PeerAggregate | null;
  position: BenchmarkPosition | null;
  /** Why there is no comparison, or which narrower groups were suppressed as too small. */
  note: string | null;
}

/**
 * Compare this organisation's metrics with the other participants' contributions. For each metric
 * the narrowest peer group with at least {@link MIN_PEERS} values is used; narrower groups with
 * fewer are suppressed. Money metrics only compare participants in the same currency.
 */
export function comparePeers(own: PeerProfile, ownValues: readonly BenchmarkMetricValue[], shared: readonly BenchmarkMetricKey[], others: readonly PeerContribution[]): BenchmarkComparison[] {
  return BENCHMARK_METRICS.map((def) => {
    const value = ownValues.find((x) => x.key === def.key)?.value ?? null;
    if (!shared.includes(def.key)) return { key: def.key, value, group: null, aggregate: null, position: null, note: 'You do not share this metric, so it is not compared.' };
    const suppressed: string[] = [];
    for (const level of PEER_GROUP_LEVELS) {
      const values = others
        .filter((o) => level.match(own, o) && (def.unit !== 'MONEY' || o.currency === own.currency))
        .map((o) => o.metrics[def.key])
        .filter((x): x is string => typeof x === 'string');
      const agg = aggregatePeers(def.key, values);
      if (!agg) {
        suppressed.push(level.label(own));
        continue;
      }
      const note = suppressed.length ? `Narrower groups had fewer than ${MIN_PEERS} participants and are not shown: ${suppressed.join('; ')}.` : null;
      return { key: def.key, value, group: { level: level.key, label: level.label(own) + (def.unit === 'MONEY' ? `, ${own.currency} only` : '') }, aggregate: agg, position: value === null ? null : benchmarkPosition(def.key, value, agg), note };
    }
    return { key: def.key, value, group: null, aggregate: null, position: null, note: `Fewer than ${MIN_PEERS} other participants have this metric yet, so no comparison is shown.` };
  });
}
