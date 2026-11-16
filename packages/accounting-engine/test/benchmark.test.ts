import { describe, expect, it } from 'vitest';
import {
  aggregatePeers,
  benchmarkMetrics,
  benchmarkPosition,
  comparePeers,
  D,
  MIN_PEERS,
  sizeBandFor,
  type BenchmarkMetricKey,
  type MonthFigures,
  type PeerContribution,
} from '../src';

const ym = (i: number) => {
  const t = 2024 * 12 + 10 + i; // Nov 2024 + i
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const end = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

/** 24 months to Oct 2026: revenue 80,000 a month in the first year and 100,000 in the second. */
function month(i: number, over: Partial<Record<keyof MonthFigures, string>> = {}): MonthFigures {
  const m = ym(i);
  const v = {
    operatingRevenue: i < 12 ? '80000' : '100000',
    otherIncome: '0',
    costOfSales: '40000',
    operatingExpenses: '30000',
    payroll: '20000',
    depreciation: '0',
    interest: '1000',
    incomeTax: '0',
    otherExpenses: '0',
    cash: '500000',
    receivables: '100000',
    inventory: '40000',
    otherCurrentAssets: '0',
    nonCurrentAssets: '0',
    payables: '50000',
    otherCurrentLiabilities: '0',
    nonCurrentLiabilities: '0',
    cashChange: '0',
    ...over,
  };
  return {
    month: m,
    from: `${m}-01`,
    to: end(m),
    days: +end(m).slice(8, 10),
    ...(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, new D(x)])) as Omit<MonthFigures, 'month' | 'from' | 'to' | 'days'>),
  };
}
const months = Array.from({ length: 24 }, (_, i) => month(i));
const valueOf = (rows: { key: string; value: string | null }[], k: BenchmarkMetricKey) => rows.find((r) => r.key === k)!.value;

describe('benchmark metrics', () => {
  it('works out all ten from the books, rounded so they reveal little', () => {
    const r = benchmarkMetrics({ months, headcount: 8, projects: { revenue: '500000.00', net: '100000.00' } });
    expect(Object.fromEntries(r.map((x) => [x.key, x.value]))).toEqual({
      GROSS_MARGIN: '60.0',
      NET_MARGIN: '29.0',
      REVENUE_GROWTH: '25.0',
      OPEX_RATIO: '30.0',
      DSO: '31', // 1,00,000 ÷ 3,00,000 × 92 days
      DPO: '31', // 50,000 ÷ 1,50,000 × 92
      WORKING_CAPITAL_DAYS: '27', // 90,000 ÷ 12,00,000 × 365
      REVENUE_PER_EMPLOYEE: '150000',
      PROJECT_MARGIN: '20.0',
      CASH_CONVERSION_CYCLE: '31', // 30.67 + 30.67 − 30.67
    });
    expect(r.find((x) => x.key === 'GROSS_MARGIN')!.components).toEqual([
      { label: 'Revenue, last 12 months', amount: '1200000.00' },
      { label: 'Cost of sales', amount: '480000.00' },
    ]);
  });

  it('says why a metric cannot be worked out', () => {
    const short = months.slice(-6);
    const r = benchmarkMetrics({ months: short, headcount: null, projects: null });
    expect(r.find((x) => x.key === 'REVENUE_GROWTH')).toMatchObject({ value: null, reason: 'Needs 24 months of books' });
    expect(r.find((x) => x.key === 'REVENUE_PER_EMPLOYEE')!.reason).toMatch(/Headcount not known/);
    expect(r.find((x) => x.key === 'PROJECT_MARGIN')!.reason).toMatch(/No revenue tagged with a project/);
    expect(r.find((x) => x.key === 'GROSS_MARGIN')!.components[0]!.label).toBe('Revenue, last 12 months (only 6 months of books)');
    const empty = benchmarkMetrics({ months: months.map((m) => ({ ...m, operatingRevenue: new D(0), costOfSales: new D(0), operatingExpenses: new D(0), payroll: new D(0), receivables: new D(0), inventory: new D(5), payables: new D(0) })), headcount: 3, projects: null });
    expect(empty.every((x) => x.value === null)).toBe(true);
  });

  it('puts headcount into size bands', () => {
    expect([1, 10, 11, 50, 51, 250, 251].map(sizeBandFor)).toEqual(['MICRO', 'MICRO', 'SMALL', 'SMALL', 'MEDIUM', 'MEDIUM', 'LARGE']);
  });
});

describe('aggregation thresholds', () => {
  it('suppresses fewer than five, shows only the median below ten, and bands the count', () => {
    expect(MIN_PEERS).toBe(5);
    expect(aggregatePeers('GROSS_MARGIN', ['10', '20', '30', '40'])).toBeNull();
    expect(aggregatePeers('GROSS_MARGIN', ['10', '20', '30', '40', '50'])).toEqual({ peers: '5 to 9', median: '30.0', lowerQuartile: null, upperQuartile: null });
    const ten = Array.from({ length: 10 }, (_, i) => String((i + 1) * 10)); // 10..100
    expect(aggregatePeers('DSO', ten)).toEqual({ peers: '10 to 24', median: '55', lowerQuartile: '32', upperQuartile: '78' });
    expect(aggregatePeers('DSO', Array.from({ length: 30 }, () => '40'))!.peers).toBe('25 or more');
  });

  it('places a value by the direction that is better', () => {
    const agg = { peers: '10 to 24' as const, median: '50', lowerQuartile: '30', upperQuartile: '70' };
    expect(benchmarkPosition('GROSS_MARGIN', '75', agg)).toBe('TOP_QUARTER');
    expect(benchmarkPosition('GROSS_MARGIN', '60', agg)).toBe('ABOVE_MEDIAN');
    expect(benchmarkPosition('GROSS_MARGIN', '50', agg)).toBe('AT_MEDIAN');
    expect(benchmarkPosition('GROSS_MARGIN', '10', agg)).toBe('BOTTOM_QUARTER');
    // Fewer days to collect is better.
    expect(benchmarkPosition('DSO', '25', agg)).toBe('TOP_QUARTER');
    expect(benchmarkPosition('DSO', '75', agg)).toBe('BOTTOM_QUARTER');
    expect(benchmarkPosition('DSO', '45', { ...agg, lowerQuartile: null, upperQuartile: null })).toBe('ABOVE_MEDIAN');
  });
});

describe('peer groups', () => {
  const own = { industry: 'RETAIL' as const, sizeBand: 'SMALL' as const, countryCode: 'IN', currency: 'INR' };
  const peer = (over: Partial<PeerContribution>, gm: string): PeerContribution => ({ ...own, metrics: { GROSS_MARGIN: gm, REVENUE_PER_EMPLOYEE: '200000' }, ...over });
  const values = benchmarkMetrics({ months, headcount: 8, projects: null });

  it('uses the narrowest group with enough participants and says which were suppressed', () => {
    const others = [
      ...['20', '25', '30'].map((g) => peer({}, g)), // same industry, size and country: only 3
      ...['35', '40'].map((g) => peer({ countryCode: 'AE', currency: 'AED' }, g)), // same industry and size: 5 with the 3 above
      ...['50', '55', '60'].map((g) => peer({ industry: 'SOFTWARE' }, g)),
    ];
    const r = comparePeers(own, values, ['GROSS_MARGIN', 'REVENUE_PER_EMPLOYEE', 'DSO'], others);
    const gm = r.find((x) => x.key === 'GROSS_MARGIN')!;
    expect(gm.group).toEqual({ level: 'INDUSTRY_SIZE', label: 'Retail, 11 to 50 people, any country' });
    expect(gm.aggregate).toEqual({ peers: '5 to 9', median: '30.0', lowerQuartile: null, upperQuartile: null });
    expect(gm.position).toBe('ABOVE_MEDIAN');
    expect(gm.note).toMatch(/Retail, 11 to 50 people, IN/);
    // Money is compared only in the same currency: 3 INR retail + 3 INR software = 6 in "all".
    const rpe = r.find((x) => x.key === 'REVENUE_PER_EMPLOYEE')!;
    expect(rpe.group).toEqual({ level: 'ALL', label: 'All participants, INR only' });
    expect(rpe.position).toBe('BELOW_MEDIAN');
    // Nobody shares DSO.
    expect(r.find((x) => x.key === 'DSO')).toMatchObject({ group: null, aggregate: null, note: expect.stringMatching(/Fewer than 5 other participants/) });
    // Not shared by this organisation: not compared.
    expect(r.find((x) => x.key === 'NET_MARGIN')).toMatchObject({ aggregate: null, note: 'You do not share this metric, so it is not compared.' });
  });

  it('never returns a single participant’s value', () => {
    const r = comparePeers(own, values, ['GROSS_MARGIN'], [peer({}, '99.9')]);
    expect(JSON.stringify(r)).not.toContain('99.9');
  });
});
