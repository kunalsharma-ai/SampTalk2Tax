import { D, Dec, dec } from './money';
import { runTwin, type TwinBaseline, type TwinDriverWithMeta, type TwinResult } from './twin';

/**
 * The financial recovery planner. From the organisation's own books (its months of figures, who
 * owes it money, whom it buys from and what it spends on) it lists recovery options, turns each
 * into digital-twin changes and measures it by running the twin with and without it. A plan is a
 * chosen set of options, forecast together. Nothing here does anything: options are proposals,
 * and people carry them out.
 */

export const RECOVERY_CATEGORIES = ['COLLECTIONS', 'CASH_CONSERVATION', 'EXPENSES', 'SUPPLIERS', 'FINANCING', 'REVENUE', 'RESTRUCTURING'] as const;
export type RecoveryCategory = (typeof RECOVERY_CATEGORIES)[number];

export interface RecoveryCustomer {
  contactId: string;
  name: string;
  /** Past due, by how late. */
  overdue1to30: string;
  overdue31to90: string;
  overdueOver90: string;
}

export interface RecoverySupplier {
  contactId: string;
  name: string;
  /** Average monthly purchases over the baseline months. */
  monthlySpend: string;
  /** Still owed to the supplier. */
  balance: string;
}

export interface RecoveryExpense {
  accountId: string;
  code: string;
  name: string;
  /** Average monthly spend over the baseline months (operating expense accounts only). */
  monthly: string;
}

export interface RecoveryInput {
  baseline: TwinBaseline;
  horizonMonths: number;
  cashBuffer?: string | null;
  customers: RecoveryCustomer[];
  suppliers: RecoverySupplier[];
  expenses: RecoveryExpense[];
}

export interface RecoveryTarget {
  id: string;
  name: string;
  amount: string;
  note: string;
}

export interface RecoveryEffect {
  netProfit: string;
  closingCash: string;
  minimumCash: string;
  cashNegativeFrom: string | null;
  /** Months of cash left (counting from the first projected month); null when it never runs out. */
  runwayMonths: number | null;
}

export interface RecoveryOption {
  key: string;
  category: RecoveryCategory;
  title: string;
  detail: string;
  drivers: TwinDriverWithMeta[];
  /** People, customers or suppliers to act on, largest first. */
  targets: RecoveryTarget[];
  risks: string[];
  /** Needs a decision about people, contracts or borrowing; never something to carry out lightly. */
  needsDecision: boolean;
  /** Change against taking no action. */
  effect: RecoveryEffect;
}

export interface RecoverySummary {
  closingCash: string;
  minimumCash: { amount: string; month: string };
  cashNegativeFrom: string | null;
  cashRequired: string;
  netProfit: string;
  runwayMonths: number | null;
  /** Month-end cash. */
  cash: { month: string; closingCash: string }[];
}

export interface RecoveryResult {
  currency: string;
  /** Collection and payment days of the baseline, for context. */
  collectionDays: string;
  paymentDays: string;
  noAction: RecoverySummary;
  options: RecoveryOption[];
}

export interface RecoveryPlanForecast {
  noAction: RecoverySummary;
  withPlan: RecoverySummary;
  effect: RecoveryEffect;
  /** Whether the plan keeps cash at or above the buffer for the whole horizon. */
  gapClosed: boolean;
  risks: TwinResult['risks'];
  assumptions: string[];
}

type Run = (drivers: readonly TwinDriverWithMeta[]) => TwinResult;

function runway(r: TwinResult): number | null {
  const neg = r.projection.cashNegativeFrom;
  if (!neg) return null;
  return r.projection.months.findIndex((m) => m.month === neg);
}

function summary(r: TwinResult): RecoverySummary {
  const p = r.projection;
  return {
    closingCash: p.closingCash,
    minimumCash: p.minimumCash,
    cashNegativeFrom: p.cashNegativeFrom,
    cashRequired: p.cashRequired,
    netProfit: p.totals.netProfit,
    runwayMonths: runway(r),
    cash: p.months.map((m) => ({ month: m.month, closingCash: m.closingCash })),
  };
}

function effectOf(r: TwinResult, base: TwinResult, scale: number): RecoveryEffect {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  return {
    netProfit: f(dec(r.projection.totals.netProfit).minus(base.projection.totals.netProfit)),
    closingCash: f(dec(r.projection.closingCash).minus(base.projection.closingCash)),
    minimumCash: f(dec(r.projection.minimumCash.amount).minus(base.projection.minimumCash.amount)),
    cashNegativeFrom: r.projection.cashNegativeFrom,
    runwayMonths: runway(r),
  };
}

const roundUp = (x: Dec, step: number) => x.div(step).toDecimalPlaces(0, D.ROUND_UP).times(step);

/** Recovery options for the organisation, each measured against taking no action. */
export function recoveryOptions(input: RecoveryInput): RecoveryResult {
  const scale = input.baseline.scale;
  const cur = input.baseline.currency;
  const H = input.horizonMonths;
  const fmt = (v: Dec | string) => `${cur} ${dec(v).toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale)}`;
  const run: Run = (drivers) => runTwin({ baseline: input.baseline, drivers, horizonMonths: H, cashBuffer: input.cashBuffer ?? null });
  const base = run([]);
  const b = base.baseline;
  const options: RecoveryOption[] = [];
  const add = (o: Omit<RecoveryOption, 'effect'>) => options.push({ ...o, effect: effectOf(run(o.drivers), base, scale) });
  const dailyRevenue = dec(b.revenue).div(30);
  const collectionDays = dec(b.collectionDays);
  const paymentDays = dec(b.paymentDays);
  const required = dec(base.projection.cashRequired);
  const negative = base.projection.cashNegativeFrom;
  const firstNegative = negative ? base.projection.months.findIndex((m) => m.month === negative) + 1 : 0;

  // ---- Collections
  const overdue = input.customers
    .map((c) => ({ c, total: dec(c.overdue1to30).plus(c.overdue31to90).plus(c.overdueOver90), recoverable: dec(c.overdue1to30).plus(c.overdue31to90) }))
    .filter((x) => x.total.gt(0))
    .sort((x, y) => y.total.cmp(x.total));
  const recoverable = overdue.reduce((a, x) => a.plus(x.recoverable), new D(0));
  if (recoverable.gt(0) && dailyRevenue.gt(0)) {
    // Collecting overdue invoices shortens the time customers take to pay; up to 90 days late is
    // counted as recoverable, older debt is listed but not counted.
    const n = overdue.filter((x) => x.recoverable.gt(0)).length;
    const days = Math.min(collectionDays.toNumber(), Math.max(1, Math.round(recoverable.div(dailyRevenue).toNumber())));
    if (days >= 1 && collectionDays.gte(1)) {
      add({
        key: 'COLLECT_OVERDUE',
        category: 'COLLECTIONS',
        title: 'Chase overdue invoices',
        detail: `${fmt(recoverable)} is up to 90 days overdue across ${n} customer${n === 1 ? '' : 's'}. Collecting it brings the time customers take to pay down by about ${days} days.${overdue.some((x) => dec(x.c.overdueOver90).gt(0)) ? ' Debt more than 90 days late is listed but not counted.' : ''}`,
        drivers: [{ kind: 'WORKING_CAPITAL', collectionDaysChange: -days, paymentDaysChange: 0, fromMonth: 1, label: 'Collect overdue invoices (recovery)' }],
        targets: overdue.slice(0, 10).map((x) => ({ id: x.c.contactId, name: x.c.name, amount: x.total.toFixed(scale), note: dec(x.c.overdueOver90).gt(0) ? `${fmt(x.c.overdueOver90)} more than 90 days late` : `${fmt(x.recoverable)} up to 90 days late` })),
        risks: ['Pressing customers hard can strain relationships; start with the largest and oldest balances.'],
        needsDecision: false,
      });
    }
  }
  if (collectionDays.gte(20)) {
    add({
      key: 'COLLECT_SOONER',
      category: 'COLLECTIONS',
      title: 'Shorten payment terms for new invoices',
      detail: `Customers take about ${collectionDays.toFixed(0)} days to pay. Asking for payment 10 days sooner (shorter terms, deposits, early-payment discounts) from month 2.`,
      drivers: [{ kind: 'WORKING_CAPITAL', collectionDaysChange: -10, paymentDaysChange: 0, fromMonth: Math.min(2, H), label: 'Shorter customer terms (recovery)' }],
      targets: [],
      risks: ['Some customers may push back or buy less; an early-payment discount costs margin.'],
      needsDecision: false,
    });
  }

  // ---- Suppliers
  const suppliers = input.suppliers.filter((s) => dec(s.monthlySpend).gt(0)).sort((x, y) => dec(y.monthlySpend).cmp(x.monthlySpend));
  const supplierTargets = suppliers.slice(0, 10).map((s) => ({ id: s.contactId, name: s.name, amount: dec(s.monthlySpend).toFixed(scale), note: `About ${fmt(s.monthlySpend)} a month; ${fmt(s.balance)} owed now` }));
  if (suppliers.length) {
    add({
      key: 'EXTEND_SUPPLIER_TERMS',
      category: 'SUPPLIERS',
      title: 'Ask suppliers for longer payment terms',
      detail: `Suppliers are paid in about ${paymentDays.toFixed(0)} days. Agreeing 15 more days with the largest suppliers keeps that cash in the business longer.`,
      drivers: [{ kind: 'WORKING_CAPITAL', collectionDaysChange: 0, paymentDaysChange: 15, fromMonth: 1, label: 'Longer supplier terms (recovery)' }],
      targets: supplierTargets,
      risks: ['Suppliers may refuse, raise prices or tighten credit; paying late without agreement damages trust and can breach contracts.'],
      needsDecision: true,
    });
  }
  if (dec(b.costOfSales).gt(0)) {
    add({
      key: 'SUPPLIER_DISCOUNT',
      category: 'SUPPLIERS',
      title: 'Renegotiate supplier prices by 3%',
      detail: `Cost of sales is about ${fmt(b.costOfSales)} a month. Getting 3% off from month 2, through volume deals, alternative suppliers or dropping extras.`,
      drivers: [{ kind: 'SUPPLIER_COST', percent: '-3', fromMonth: Math.min(2, H), label: 'Supplier prices down 3% (recovery)' }],
      targets: supplierTargets,
      risks: ['Cheaper supply can mean lower quality or less reliable delivery.'],
      needsDecision: true,
    });
  }

  // ---- Expenses: the largest operating cost lines, one option each
  const lines = input.expenses.filter((e) => dec(e.monthly).gt(0)).sort((x, y) => dec(y.monthly).cmp(x.monthly));
  for (const e of lines.slice(0, 5)) {
    const cut = dec(e.monthly).times(0.2);
    add({
      key: `CUT_${e.code}`,
      category: 'EXPENSES',
      title: `Cut ${e.name} by 20%`,
      detail: `${e.code} ${e.name} averages ${fmt(e.monthly)} a month. Cutting a fifth saves about ${fmt(cut)} a month from month 1.`,
      drivers: [{ kind: 'EXPENSE_CHANGE', target: 'OPERATING', monthlyAmount: cut.negated().toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale), fromMonth: 1, label: `${e.name} down 20% (recovery)` }],
      targets: [{ id: e.accountId, name: `${e.code} ${e.name}`, amount: dec(e.monthly).toFixed(scale), note: 'Average a month' }],
      risks: ['Check what the spend pays for before cutting; contracts may have notice periods.'],
      needsDecision: false,
    });
  }
  if (dec(b.otherOperating).gt(0)) {
    add({
      key: 'SPENDING_FREEZE',
      category: 'CASH_CONSERVATION',
      title: 'Freeze non-essential spending',
      detail: `Hold back 10% of other operating costs (about ${fmt(dec(b.otherOperating).times(0.1))} a month) by approving only essential purchases.`,
      drivers: [{ kind: 'EXPENSE_CHANGE', target: 'OPERATING', percent: '-10', fromMonth: 1, label: 'Spending freeze (recovery)' }],
      targets: [],
      risks: ['Overlaps with cutting individual cost lines: adding both counts some savings twice.'],
      needsDecision: false,
    });
  }

  // ---- Financing
  if (required.gt(0)) {
    const month = Math.max(1, firstNegative - 1);
    const loanOf = (a: Dec): TwinDriverWithMeta => ({ kind: 'NEW_DEBT', amount: a.toFixed(0), annualRatePercent: '12', termMonths: 24, month, label: 'Working capital loan (recovery)' });
    let amount = roundUp(required.times(1.1), 1000);
    let r = run([loanOf(amount)]);
    for (let i = 0; i < 20 && dec(r.projection.cashRequired).gt(0); i++) {
      amount = amount.plus(roundUp(dec(r.projection.cashRequired).times(1.1), 1000));
      r = run([loanOf(amount)]);
    }
    add({
      key: 'BRIDGE_LOAN',
      category: 'FINANCING',
      title: `Arrange a working capital loan of ${fmt(amount)}`,
      detail: `Cash ${negative ? `runs out in ${negative}` : 'falls below the minimum balance'}. A 2-year loan at 12% received in month ${month}, sized so the repayments do not open a new gap.`,
      drivers: [loanOf(amount)],
      targets: [],
      risks: ['Borrowing adds interest and fixed repayments; lenders will want the plan, security or guarantees.'],
      needsDecision: true,
    });
    const equity = roundUp(required.times(1.1), 1000);
    add({
      key: 'OWNER_FUNDING',
      category: 'FINANCING',
      title: `Raise ${fmt(equity)} from owners or investors`,
      detail: `New capital in month ${month}. It is not repaid and costs no interest, but it gives away ownership or comes from the owners themselves.`,
      drivers: [{ kind: 'ONE_OFF', label: 'New capital (recovery)', amount: equity.toFixed(0), month, affectsProfit: false }],
      targets: [],
      risks: ['Dilutes ownership; takes time to agree.'],
      needsDecision: true,
    });
  }

  // ---- Revenue
  if (dec(b.revenue).gt(0)) {
    add({
      key: 'PRICE_RISE',
      category: 'REVENUE',
      title: 'Raise prices by 5%',
      detail: 'Prices up 5% from month 2, assuming 2% fewer sales.',
      drivers: [{ kind: 'PRICE_CHANGE', pricePercent: '5', volumePercent: '-2', fromMonth: Math.min(2, H), label: 'Prices up 5% (recovery)' }],
      targets: [],
      risks: ['Customers may buy less than assumed or move to competitors.'],
      needsDecision: false,
    });
  }

  // ---- Restructuring: modelled only, always a decision for people
  if (dec(b.payroll).gt(0)) {
    add({
      key: 'PAYROLL_REDUCTION',
      category: 'RESTRUCTURING',
      title: 'Reduce payroll costs by 10%',
      detail: `Payroll is about ${fmt(b.payroll)} a month. This only models 10% less from month 3, for example through a hiring freeze, not replacing leavers or reduced hours. It is not a recommendation to let anyone go.`,
      drivers: [{ kind: 'EXPENSE_CHANGE', target: 'PAYROLL', percent: '-10', fromMonth: Math.min(3, H), label: 'Payroll down 10% (recovery)' }],
      targets: [],
      risks: ['Affects people: notice periods, legal obligations, severance and morale. A decision for the owners, with advice.'],
      needsDecision: true,
    });
  }

  return { currency: cur, collectionDays: b.collectionDays, paymentDays: b.paymentDays, noAction: summary(base), options };
}

/** A chosen set of changes forecast together against taking no action. */
export function recoveryForecast(input: Pick<RecoveryInput, 'baseline' | 'horizonMonths' | 'cashBuffer'>, drivers: readonly TwinDriverWithMeta[]): RecoveryPlanForecast {
  const run: Run = (d) => runTwin({ baseline: input.baseline, drivers: d, horizonMonths: input.horizonMonths, cashBuffer: input.cashBuffer ?? null });
  const base = run([]);
  const plan = run(drivers);
  return {
    noAction: summary(base),
    withPlan: summary(plan),
    effect: effectOf(plan, base, input.baseline.scale),
    gapClosed: dec(plan.projection.cashRequired).isZero(),
    risks: plan.risks,
    assumptions: plan.assumptions,
  };
}
