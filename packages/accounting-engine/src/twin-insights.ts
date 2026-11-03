import { D, Dec, dec } from './money';
import { runTwin, type TwinBaseline, type TwinDriverWithMeta, type TwinResult } from './twin';

/**
 * Explanations for a twin scenario, worked out by running the model again rather than guessed:
 *  - the impact of each change: the full scenario against the same scenario without that change;
 *  - the impact by department: the sum of the impacts of the changes tagged with it;
 *  - suggestions: small standard remedies (collect sooner, raise prices, fund the gap, delay the
 *    largest cost) tried on top of the scenario, each with its measured effect.
 * Impacts are marginal, so they need not add up to the scenario's total effect when changes
 * interact (a price rise on top of growth, say); the difference is reported as interaction.
 */

export interface TwinImpact {
  /** 0-based position of the change in the scenario. */
  index: number;
  kind: TwinDriverWithMeta['kind'];
  departmentId: string | null;
  netProfit: string;
  ebitda: string;
  closingCash: string;
  minimumCash: string;
}

export interface TwinDepartmentImpact {
  departmentId: string | null;
  changes: number[];
  netProfit: string;
  closingCash: string;
}

export interface TwinSuggestion {
  code: 'FUND_GAP' | 'COLLECT_SOONER' | 'PRICE_RISE' | 'DELAY_LARGEST_COST' | 'SET_TAX_RATE';
  title: string;
  message: string;
  /** Changes to add to (or, for DELAY_LARGEST_COST, the change that replaces `replaces` in) the scenario to try it. */
  drivers: TwinDriverWithMeta[];
  replaces: number | null;
  effect: { netProfit: string; closingCash: string; minimumCash: string; cashNegativeFrom: string | null };
}

export interface TwinInsights {
  total: { netProfit: string; closingCash: string };
  impacts: TwinImpact[];
  interaction: { netProfit: string; closingCash: string };
  departments: TwinDepartmentImpact[];
  suggestions: TwinSuggestion[];
}

type Input = { baseline: TwinBaseline; drivers: readonly TwinDriverWithMeta[]; horizonMonths: number; cashBuffer?: string | null };

const totals = (r: TwinResult) => ({
  netProfit: dec(r.projection.totals.netProfit),
  ebitda: dec(r.projection.totals.ebitda),
  closingCash: dec(r.projection.closingCash),
  minimumCash: dec(r.projection.minimumCash.amount),
});

const COST_KINDS = new Set(['HIRING', 'EXPENSE_CHANGE', 'EXPANSION', 'INVESTMENT', 'SUPPLIER_COST']);

export function twinInsights(input: Input, full?: TwinResult): TwinInsights {
  const scale = input.baseline.scale;
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const run = (drivers: readonly TwinDriverWithMeta[]) => runTwin({ ...input, drivers });
  const all = full ?? run(input.drivers);
  const base = run([]);
  const A = totals(all);
  const B = totals(base);
  const fmt = (v: Dec) => `${input.baseline.currency} ${v.abs().toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale)}`;

  const impacts: TwinImpact[] = input.drivers.map((d, i) => {
    const without = totals(run(input.drivers.filter((_, j) => j !== i)));
    return {
      index: i,
      kind: d.kind,
      departmentId: d.departmentId ?? null,
      netProfit: f(A.netProfit.minus(without.netProfit)),
      ebitda: f(A.ebitda.minus(without.ebitda)),
      closingCash: f(A.closingCash.minus(without.closingCash)),
      minimumCash: f(A.minimumCash.minus(without.minimumCash)),
    };
  });
  const sum = (k: 'netProfit' | 'closingCash') => impacts.reduce((a, x) => a.plus(x[k]), new D(0));
  const interaction = { netProfit: f(A.netProfit.minus(B.netProfit).minus(sum('netProfit'))), closingCash: f(A.closingCash.minus(B.closingCash).minus(sum('closingCash'))) };

  const byDept = new Map<string | null, TwinDepartmentImpact>();
  for (const x of impacts) {
    const g = byDept.get(x.departmentId) ?? { departmentId: x.departmentId, changes: [], netProfit: '0', closingCash: '0' };
    g.changes.push(x.index);
    g.netProfit = f(dec(g.netProfit).plus(x.netProfit));
    g.closingCash = f(dec(g.closingCash).plus(x.closingCash));
    byDept.set(x.departmentId, g);
  }
  const departments = [...byDept.values()].sort((a, b) => (a.departmentId === null ? 1 : b.departmentId === null ? -1 : dec(a.netProfit).cmp(b.netProfit)));

  // ---- suggestions, each measured by running the scenario with the remedy applied.
  const suggestions: TwinSuggestion[] = [];
  const effect = (r: TwinResult) => {
    const t = totals(r);
    return { netProfit: f(t.netProfit.minus(A.netProfit)), closingCash: f(t.closingCash.minus(A.closingCash)), minimumCash: f(t.minimumCash.minus(A.minimumCash)), cashNegativeFrom: r.projection.cashNegativeFrom };
  };
  const tryAdd = (extra: TwinDriverWithMeta[]) => effect(run([...input.drivers, ...extra]));
  const H = input.horizonMonths;
  const required = dec(all.projection.cashRequired);
  const negativeFrom = all.projection.cashNegativeFrom;
  const firstMonthIndex = (ym: string | null) => (ym ? all.projection.months.findIndex((m) => m.month === ym) + 1 : 0);

  if (required.gt(0) && negativeFrom) {
    // Fund the gap with a three-year loan received one month before cash runs out (or at once).
    const month = Math.max(1, firstMonthIndex(negativeFrom) - 1);
    const amount = required.times(1.1).div(1000).toDecimalPlaces(0, D.ROUND_UP).times(1000);
    const loan: TwinDriverWithMeta = { kind: 'NEW_DEBT', amount: amount.toFixed(0), annualRatePercent: '11', termMonths: 36, month, label: 'Working capital loan (suggested)' };
    const e = tryAdd([loan]);
    suggestions.push({
      code: 'FUND_GAP',
      title: 'Arrange funding before cash runs out',
      message: `Cash runs out in ${negativeFrom}. A loan of ${fmt(amount)} at 11% over 36 months, received in month ${month}, ${e.cashNegativeFrom ? `still leaves cash negative from ${e.cashNegativeFrom}` : 'keeps cash positive for the whole period'}, at a cost of ${fmt(dec(e.netProfit))} in interest.`,
      drivers: [loan],
      replaces: null,
      effect: e,
    });
  }
  const collectDays = dec(all.baseline.collectionDays);
  if (collectDays.gte(20)) {
    const wc: TwinDriverWithMeta = { kind: 'WORKING_CAPITAL', collectionDaysChange: -10, paymentDaysChange: 0, fromMonth: 1, label: 'Collect 10 days sooner (suggested)' };
    const e = tryAdd([wc]);
    if (dec(e.closingCash).gt(0)) {
      suggestions.push({
        code: 'COLLECT_SOONER',
        title: 'Collect from customers sooner',
        message: `Customers take about ${collectDays.toFixed(0)} days to pay. Collecting 10 days sooner from month 1 would release ${fmt(dec(e.closingCash))} of cash by the end${e.cashNegativeFrom === null && negativeFrom ? ', enough to keep cash positive' : ''}.`,
        drivers: [wc],
        replaces: null,
        effect: e,
      });
    }
  }
  if (A.netProfit.lt(B.netProfit) || A.netProfit.lt(0)) {
    const price: TwinDriverWithMeta = { kind: 'PRICE_CHANGE', pricePercent: '5', volumePercent: '-2', fromMonth: Math.min(2, H), label: 'Prices up 5% (suggested)' };
    const e = tryAdd([price]);
    if (dec(e.netProfit).gt(0)) {
      suggestions.push({
        code: 'PRICE_RISE',
        title: 'Test a price rise',
        message: `Raising prices 5% from month ${Math.min(2, H)}, even losing 2% of volume, would add ${fmt(dec(e.netProfit))} of profit over ${H} months.`,
        drivers: [price],
        replaces: null,
        effect: e,
      });
    }
  }
  // The change that costs the most profit: try starting it three months later, or not at all.
  const costly = impacts.filter((x) => COST_KINDS.has(x.kind) && dec(x.netProfit).lt(0)).sort((a, b) => dec(a.netProfit).cmp(b.netProfit))[0];
  if (costly && (A.netProfit.lt(0) || required.gt(0))) {
    const d = input.drivers[costly.index]!;
    const startKey = 'fromMonth' in d ? 'fromMonth' : 'month' in d ? 'month' : null;
    const start = startKey ? (((d as Record<string, unknown>)[startKey] as number | undefined) ?? 1) : null;
    if (startKey && start !== null && start + 3 <= H) {
      const later = { ...d, [startKey]: start + 3 } as TwinDriverWithMeta;
      const e = effect(run(input.drivers.map((x, j) => (j === costly.index ? later : x))));
      if (dec(e.closingCash).gt(0) || dec(e.netProfit).gt(0)) {
        suggestions.push({
          code: 'DELAY_LARGEST_COST',
          title: `Start change ${costly.index + 1} three months later`,
          message: `Change ${costly.index + 1} costs the most: ${fmt(dec(costly.netProfit))} of profit. Starting it in month ${start + 3} instead of month ${start} would improve profit by ${fmt(dec(e.netProfit))} and cash at the end by ${fmt(dec(e.closingCash))}${e.cashNegativeFrom === null && negativeFrom ? ', and cash would stay positive' : ''}.`,
          drivers: [later],
          replaces: costly.index,
          effect: e,
        });
      }
    }
  }
  if (all.baseline.taxRateSource === 'NONE' && A.netProfit.gt(0) && input.baseline.currency === 'INR') {
    const tax: TwinDriverWithMeta = { kind: 'TAX_RATE', percent: '25.17', label: 'Income tax 25.17% (suggested, India new-regime company rate)' };
    const e = tryAdd([tax]);
    suggestions.push({
      code: 'SET_TAX_RATE',
      title: 'Include income tax',
      message: `No income tax is assumed. At 25.17% (the Indian rate for companies under section 115BAA), profit after tax would be ${fmt(dec(e.netProfit))} lower. Use your own rate if different.`,
      drivers: [tax],
      replaces: null,
      effect: e,
    });
  }

  return { total: { netProfit: f(A.netProfit.minus(B.netProfit)), closingCash: f(A.closingCash.minus(B.closingCash)) }, impacts, interaction, departments, suggestions };
}
