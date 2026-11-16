import { monthLabel } from './cfo';
import { D, type Dec } from './money';
import { checkDriver, runTwin, shiftYm, TwinError, type TwinBaseline, type TwinDriverWithMeta, type TwinProjection, type TwinResult } from './twin';

/**
 * Financial disaster simulation: severe but plausible shocks (a customer defaulting, a supplier
 * failing, cash frozen or credit withdrawn, operations stopped, demand collapsing) turned into
 * digital-twin changes built from the organisation's own figures, and played forward from the
 * posted books. Each shock is also run on its own, so the damage can be attributed.
 *
 * Every shock becomes ordinary twin changes, so the twin's model applies unchanged: revenue
 * lost takes its cost of sales with it, receivables and payables follow revenue and costs at
 * the business's own collection and payment days, and write-offs go through profit.
 */

export const SHOCK_KINDS = ['CUSTOMER_DEFAULT', 'SUPPLIER_FAILURE', 'LIQUIDITY_SHOCK', 'OPERATIONAL_DISRUPTION', 'DEMAND_SHOCK'] as const;
export type ShockKind = (typeof SHOCK_KINDS)[number];

export const SHOCK_INFO: Record<ShockKind, { label: string; description: string }> = {
  CUSTOMER_DEFAULT: { label: 'Customer default', description: 'A customer cannot pay what it owes and stops buying.' },
  SUPPLIER_FAILURE: { label: 'Supplier failure', description: 'A supplier stops delivering: sales are lost until a replacement is found, and the replacement costs more.' },
  LIQUIDITY_SHOCK: { label: 'Liquidity shock', description: 'Cash is frozen, a credit line is withdrawn, or customers pay later.' },
  OPERATIONAL_DISRUPTION: { label: 'Operational disruption', description: 'A fire, flood, system failure or strike stops or slows the business, with recovery costs and perhaps an insurance payout.' },
  DEMAND_SHOCK: { label: 'Demand collapse', description: 'Sales fall across the board for a while, and customers take longer to pay.' },
};

/** Month numbers are 1-based offsets into the projection (1 = the first projected month). */
export type DisasterShock =
  | { kind: 'CUSTOMER_DEFAULT'; contactId: string; writeOffPercent: string; loseFutureSales: boolean; month?: number }
  | { kind: 'SUPPLIER_FAILURE'; contactId: string; disruptionMonths: number; revenueLostPercent: string; replacementPremiumPercent: string; month?: number }
  | { kind: 'LIQUIDITY_SHOCK'; frozenCash: string; frozenMonths: number; creditWithdrawn: string; collectionDelayDays: number; delayMonths: number; month?: number }
  | { kind: 'OPERATIONAL_DISRUPTION'; revenueLostPercent: string; months: number; recoveryCost: string; insuranceRecovery: string; insuranceMonthsLater: number; month?: number }
  | { kind: 'DEMAND_SHOCK'; revenueLostPercent: string; months: number; extraCollectionDays: number; month?: number };

/** Customers and suppliers from the books, over the baseline months. */
export interface DisasterCustomer {
  contactId: string;
  name: string;
  /** Average monthly sales to the customer in the baseline months. */
  monthlyRevenue: string;
  /** What the customer owes now. */
  balance: string;
}
export interface DisasterSupplier {
  contactId: string;
  name: string;
  /** Average monthly bills from the supplier in the baseline months. */
  monthlySpend: string;
}

export interface DisasterInput {
  baseline: TwinBaseline;
  horizonMonths: number;
  cashBuffer?: string | null;
  customers: readonly DisasterCustomer[];
  suppliers: readonly DisasterSupplier[];
}

export interface DisasterImpact {
  /** Net profit over the horizon, stressed minus no-shock. */
  profitChange: string;
  /** Lowest month-end cash with the shocks, and when. */
  lowestCash: { amount: string; month: string };
  /** Lowest cash with the shocks minus lowest cash without. */
  lowestCashChange: string;
  closingCashChange: string;
  /** The month cash is furthest below the no-shock projection, and by how much (zero or negative). */
  largestCashGap: { amount: string; month: string };
  cashNegativeFrom: string | null;
  /** Money to raise to keep cash at or above the minimum balance throughout. */
  cashRequired: string;
  /** Full months before cash first falls below the minimum balance; null if it never does. */
  monthsBeforeShortfall: number | null;
  verdict: 'SURVIVES' | 'BELOW_BUFFER' | 'RUNS_OUT';
}

export interface ShockResult {
  index: number;
  kind: ShockKind;
  title: string;
  /** How the shock was turned into figures, in words. */
  explanation: string[];
  drivers: TwinDriverWithMeta[];
  /** The shock on its own, against no shock. */
  alone: DisasterImpact;
}

export interface DisasterResult {
  noShock: TwinProjection;
  stressed: TwinResult;
  impact: DisasterImpact;
  shocks: ShockResult[];
  summary: string;
}

const NUM = /^-?\d{1,14}(\.\d{1,6})?$/;
const dec = (v: string | Dec) => new D(v);
const pct = (v: string) => dec(v).div(100);

/** Problems with a shock, in words. Empty when it is fine. */
export function checkShock(s: DisasterShock, horizon: number, ctx: Pick<DisasterInput, 'customers' | 'suppliers'>): string[] {
  const issues: string[] = [];
  const num = (v: unknown, label: string, min: number, max?: number) => {
    if (typeof v !== 'string' || !NUM.test(v)) return issues.push(`${label}: enter a number`);
    const x = dec(v);
    if (x.lt(min)) issues.push(`${label} must be at least ${min}`);
    if (max !== undefined && x.gt(max)) issues.push(`${label} must be at most ${max}`);
  };
  const int = (v: unknown, label: string, min: number, max: number) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) issues.push(`${label} must be a whole number from ${min} to ${max}`);
  };
  if (s.month !== undefined) int(s.month, 'Month it starts', 1, horizon);
  switch (s.kind) {
    case 'CUSTOMER_DEFAULT':
      if (!ctx.customers.some((c) => c.contactId === s.contactId)) issues.push('Choose a customer from the list');
      num(s.writeOffPercent, 'Share of the balance never paid (%)', 0, 100);
      if (typeof s.loseFutureSales !== 'boolean') issues.push('Say whether future sales to the customer are lost');
      break;
    case 'SUPPLIER_FAILURE':
      if (!ctx.suppliers.some((c) => c.contactId === s.contactId)) issues.push('Choose a supplier from the list');
      int(s.disruptionMonths, 'Months until a replacement delivers', 0, 60);
      num(s.revenueLostPercent, 'Sales lost meanwhile (%)', 0, 100);
      num(s.replacementPremiumPercent, 'Replacement costs more by (%)', 0, 500);
      break;
    case 'LIQUIDITY_SHOCK': {
      const before = issues.length;
      num(s.frozenCash, 'Cash frozen', 0);
      int(s.frozenMonths, 'Months the cash stays frozen', 1, 60);
      num(s.creditWithdrawn, 'Credit line withdrawn (repaid at once)', 0);
      int(s.collectionDelayDays, 'Extra days customers take to pay', 0, 365);
      int(s.delayMonths, 'Months customers pay late', 1, 60);
      if (issues.length === before && dec(s.frozenCash).isZero() && dec(s.creditWithdrawn).isZero() && s.collectionDelayDays === 0) issues.push('Enter cash frozen, credit withdrawn or a payment delay');
      break;
    }
    case 'OPERATIONAL_DISRUPTION':
      num(s.revenueLostPercent, 'Sales lost (%)', 0, 100);
      int(s.months, 'Months it lasts', 1, 60);
      num(s.recoveryCost, 'Cost to recover', 0);
      num(s.insuranceRecovery, 'Insurance payout', 0);
      int(s.insuranceMonthsLater, 'Months until the insurer pays', 0, 60);
      break;
    case 'DEMAND_SHOCK':
      num(s.revenueLostPercent, 'Sales lost (%)', 0, 100);
      int(s.months, 'Months it lasts', 1, 60);
      int(s.extraCollectionDays, 'Extra days customers take to pay', 0, 365);
      break;
    default:
      issues.push('Unknown kind of shock');
  }
  return issues;
}

/** Monthly averages the shares are measured against. */
function averages(b: TwinBaseline) {
  const n = b.months.length;
  const avg = (k: 'revenue' | 'costOfSales') => b.months.reduce((a, m) => a.plus(m[k]), new D(0)).div(n || 1);
  return { revenue: avg('revenue'), costOfSales: avg('costOfSales') };
}

/** One shock as twin changes, with the explanation in words. */
export function shockDrivers(s: DisasterShock, input: DisasterInput): { title: string; explanation: string[]; drivers: TwinDriverWithMeta[] } {
  const H = input.horizonMonths;
  const scale = input.baseline.scale;
  const cur = input.baseline.currency;
  const m = s.month ?? 1;
  const last = input.baseline.months[input.baseline.months.length - 1]?.month ?? '';
  const monthName = (i: number) => monthLabel(shiftYm(shiftYm(last, 1), i - 1));
  const money = (v: Dec) => `${cur} ${v.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale)}`;
  const lasting = (months: number) => Math.max(1, Math.min(months, H - m + 1));
  const avg = averages(input.baseline);
  const drivers: TwinDriverWithMeta[] = [];
  const explanation: string[] = [];
  let title: string = SHOCK_INFO[s.kind].label;
  switch (s.kind) {
    case 'CUSTOMER_DEFAULT': {
      const c = input.customers.find((x) => x.contactId === s.contactId)!;
      title = `${c.name} defaults`;
      const writeOff = dec(c.balance).times(pct(s.writeOffPercent)).toDecimalPlaces(scale, D.ROUND_HALF_UP);
      if (writeOff.gt(0)) {
        drivers.push({ kind: 'ONE_OFF', label: `Bad debt: ${c.name}`, amount: writeOff.negated().toFixed(scale), month: m, affectsProfit: true });
        explanation.push(`${s.writeOffPercent}% of the ${money(dec(c.balance))} ${c.name} owes is never paid: ${money(writeOff)} written off in ${monthName(m)}.`);
      } else explanation.push(`${c.name} owes nothing now, so there is nothing to write off.`);
      if (s.loseFutureSales) {
        const share = avg.revenue.gt(0) ? D.min(dec(c.monthlyRevenue).div(avg.revenue).times(100), 100).toDecimalPlaces(2, D.ROUND_HALF_UP) : new D(0);
        if (share.gt(0)) {
          drivers.push({ kind: 'DOWNTURN', label: `Sales to ${c.name} lost`, revenuePercent: share.toFixed(2), extraCollectionDays: 0, fromMonth: m });
          explanation.push(`Sales to ${c.name} stop from ${monthName(m)}: ${money(dec(c.monthlyRevenue))} a month, ${share.toFixed(2)}% of revenue, with the cost of those sales.`);
        } else explanation.push(`There were no sales to ${c.name} in the baseline months, so no future sales are lost.`);
      }
      break;
    }
    case 'SUPPLIER_FAILURE': {
      const sup = input.suppliers.find((x) => x.contactId === s.contactId)!;
      title = `${sup.name} fails`;
      if (s.disruptionMonths > 0 && dec(s.revenueLostPercent).gt(0)) {
        const k = lasting(s.disruptionMonths);
        drivers.push({ kind: 'DOWNTURN', label: `Sales lost without ${sup.name}`, revenuePercent: dec(s.revenueLostPercent).toFixed(), extraCollectionDays: 0, fromMonth: m, months: k });
        explanation.push(`For ${k} month${k === 1 ? '' : 's'} from ${monthName(m)}, ${s.revenueLostPercent}% of sales are lost until a replacement delivers.`);
      }
      const share = avg.costOfSales.gt(0) ? D.min(dec(sup.monthlySpend).div(avg.costOfSales), 1) : new D(0);
      const premium = pct(s.replacementPremiumPercent).times(share).times(100).toDecimalPlaces(4, D.ROUND_HALF_UP);
      if (premium.gt(0)) {
        const from = m + s.disruptionMonths;
        if (from <= H) {
          drivers.push({ kind: 'SUPPLIER_COST', label: `Replacement for ${sup.name}`, percent: premium.toFixed(), fromMonth: from });
          explanation.push(`From ${monthName(from)} the replacement costs ${s.replacementPremiumPercent}% more. ${sup.name} supplied ${money(dec(sup.monthlySpend))} a month, about ${share.times(100).toFixed(1)}% of cost of sales, so cost of sales rises ${premium.toFixed(2)}%.`);
        } else explanation.push('The replacement starts after the period simulated, so its higher cost is not included.');
      } else if (dec(s.replacementPremiumPercent).gt(0)) explanation.push(`There were no bills from ${sup.name} in the baseline months, so the replacement's higher cost has nothing to apply to.`);
      if (!drivers.length) explanation.push('With these settings the failure changes nothing.');
      break;
    }
    case 'LIQUIDITY_SHOCK': {
      const frozen = dec(s.frozenCash);
      if (frozen.gt(0)) {
        drivers.push({ kind: 'ONE_OFF', label: 'Cash frozen', amount: frozen.negated().toFixed(scale), month: m, affectsProfit: false });
        const back = m + s.frozenMonths;
        if (back <= H) {
          drivers.push({ kind: 'ONE_OFF', label: 'Frozen cash released', amount: frozen.toFixed(scale), month: back, affectsProfit: false });
          explanation.push(`${money(frozen)} cannot be used from ${monthName(m)} and is released in ${monthName(back)}.`);
        } else explanation.push(`${money(frozen)} cannot be used from ${monthName(m)} and is not released within the period.`);
      }
      const credit = dec(s.creditWithdrawn);
      if (credit.gt(0)) {
        drivers.push({ kind: 'ONE_OFF', label: 'Credit line withdrawn', amount: credit.negated().toFixed(scale), month: m, affectsProfit: false });
        explanation.push(`The bank withdraws a ${money(credit)} credit line in ${monthName(m)}, and it must be repaid at once.`);
      }
      if (s.collectionDelayDays > 0) {
        const k = lasting(s.delayMonths);
        drivers.push({ kind: 'DOWNTURN', label: 'Customers pay later', revenuePercent: '0', extraCollectionDays: s.collectionDelayDays, fromMonth: m, months: k });
        explanation.push(`Customers take ${s.collectionDelayDays} more days to pay for ${k} month${k === 1 ? '' : 's'}, then return to normal.`);
      }
      break;
    }
    case 'OPERATIONAL_DISRUPTION': {
      const k = lasting(s.months);
      if (dec(s.revenueLostPercent).gt(0)) {
        drivers.push({ kind: 'DOWNTURN', label: 'Operations disrupted', revenuePercent: dec(s.revenueLostPercent).toFixed(), extraCollectionDays: 0, fromMonth: m, months: k });
        explanation.push(`${s.revenueLostPercent}% of sales are lost for ${k} month${k === 1 ? '' : 's'} from ${monthName(m)}, with the cost of those sales; payroll and other running costs carry on.`);
      }
      const cost = dec(s.recoveryCost);
      if (cost.gt(0)) {
        drivers.push({ kind: 'ONE_OFF', label: 'Recovery cost', amount: cost.negated().toFixed(scale), month: m, affectsProfit: true });
        explanation.push(`Recovery costs ${money(cost)} in ${monthName(m)}.`);
      }
      const ins = dec(s.insuranceRecovery);
      if (ins.gt(0)) {
        const at = m + s.insuranceMonthsLater;
        if (at <= H) {
          drivers.push({ kind: 'ONE_OFF', label: 'Insurance payout', amount: ins.toFixed(scale), month: at, affectsProfit: true });
          explanation.push(`The insurer pays ${money(ins)} in ${monthName(at)}.`);
        } else explanation.push(`The insurance payout of ${money(ins)} arrives after the period simulated.`);
      }
      break;
    }
    case 'DEMAND_SHOCK': {
      const k = lasting(s.months);
      drivers.push({ kind: 'DOWNTURN', label: 'Demand collapse', revenuePercent: dec(s.revenueLostPercent).toFixed(), extraCollectionDays: s.extraCollectionDays, fromMonth: m, months: k });
      explanation.push(`Sales fall ${s.revenueLostPercent}% for ${k} month${k === 1 ? '' : 's'} from ${monthName(m)}${s.extraCollectionDays ? `, and customers take ${s.extraCollectionDays} more days to pay` : ''}. Payroll and other running costs carry on.`);
      break;
    }
  }
  for (const d of drivers) {
    const bad = checkDriver(d, H);
    if (bad.length) throw new TwinError('A shock could not be turned into figures', bad);
  }
  return { title, explanation, drivers };
}

function impactOf(base: TwinProjection, stressed: TwinProjection, buffer: Dec, scale: number): DisasterImpact {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const firstShort = stressed.months.findIndex((m) => dec(m.closingCash).lt(buffer));
  const verdict: DisasterImpact['verdict'] = stressed.cashNegativeFrom ? 'RUNS_OUT' : firstShort >= 0 ? 'BELOW_BUFFER' : 'SURVIVES';
  return {
    profitChange: f(dec(stressed.totals.netProfit).minus(base.totals.netProfit)),
    lowestCash: stressed.minimumCash,
    lowestCashChange: f(dec(stressed.minimumCash.amount).minus(base.minimumCash.amount)),
    closingCashChange: f(dec(stressed.closingCash).minus(base.closingCash)),
    largestCashGap: stressed.months.reduce(
      (a, m, k) => {
        const gap = dec(m.closingCash).minus(base.months[k]!.closingCash);
        return gap.lt(a.amount) ? { amount: f(gap), month: m.month } : a;
      },
      { amount: f(new D(0)), month: stressed.months[0]!.month },
    ),
    cashNegativeFrom: stressed.cashNegativeFrom,
    cashRequired: stressed.cashRequired,
    monthsBeforeShortfall: firstShort >= 0 ? firstShort : null,
    verdict,
  };
}

/** Plays the shocks together, and each on its own, against no shock. */
export function simulateDisaster(input: DisasterInput & { shocks: readonly DisasterShock[] }): DisasterResult {
  const H = input.horizonMonths;
  if (!input.shocks.length) throw new TwinError('Add at least one shock');
  if (input.shocks.length > 10) throw new TwinError('At most 10 shocks in a simulation');
  const issues = input.shocks.flatMap((s, i) => checkShock(s, H, input).map((m) => `Shock ${i + 1}: ${m}`));
  if (issues.length) throw new TwinError('Some shocks need fixing', issues);
  const scale = input.baseline.scale;
  const buffer = input.cashBuffer ? dec(input.cashBuffer) : new D(0);
  const run = (drivers: TwinDriverWithMeta[]) => runTwin({ baseline: input.baseline, drivers, horizonMonths: H, cashBuffer: input.cashBuffer });
  const noShock = run([]).projection;
  const built = input.shocks.map((s) => shockDrivers(s, input));
  const shocks: ShockResult[] = built.map((b, i) => ({
    index: i + 1,
    kind: input.shocks[i]!.kind,
    title: b.title,
    explanation: b.explanation,
    drivers: b.drivers,
    alone: impactOf(noShock, run(b.drivers).projection, buffer, scale),
  }));
  const stressed = run(built.flatMap((b) => b.drivers));
  const impact = impactOf(noShock, stressed.projection, buffer, scale);
  const cur = input.baseline.currency;
  const money = (v: string) => `${cur} ${dec(v).abs().toFixed(scale)}`;
  const worst = [...shocks].sort((a, b) => dec(a.alone.largestCashGap.amount).comparedTo(b.alone.largestCashGap.amount))[0]!;
  const what = shocks.length === 1 ? 'With this shock' : `With these ${shocks.length} shocks together`;
  const outcome =
    impact.verdict === 'RUNS_OUT'
      ? `cash runs out in ${monthLabel(impact.cashNegativeFrom!)}, and about ${money(impact.cashRequired)} more is needed to stay at or above the minimum balance`
      : impact.verdict === 'BELOW_BUFFER'
        ? `cash stays positive but falls to ${money(impact.lowestCash.amount)} in ${monthLabel(impact.lowestCash.month)}, below the minimum balance; about ${money(impact.cashRequired)} would keep it there`
        : `the business gets through: cash is lowest at ${money(impact.lowestCash.amount)} in ${monthLabel(impact.lowestCash.month)}`;
  const profit = dec(impact.profitChange).lt(0) ? ` Profit over ${H} months is ${money(impact.profitChange)} lower.` : '';
  const hardest = shocks.length > 1 && dec(worst.alone.largestCashGap.amount).lt(0) ? ` The hardest single shock is "${worst.title}", which on its own leaves cash up to ${money(worst.alone.largestCashGap.amount)} lower, in ${monthLabel(worst.alone.largestCashGap.month)}.` : '';
  return { noShock, stressed, impact, shocks, summary: `${what}, ${outcome}.${profit}${hardest}` };
}

export interface StressTest {
  key: string;
  title: string;
  description: string;
  shocks: DisasterShock[];
  impact: DisasterImpact;
}

/**
 * A standard set of stress tests built from the organisation's own customers, suppliers and
 * cash, ranked from the most to the least damaging to cash. Tests that do not apply (no
 * customers, no suppliers, no cash) are left out.
 */
export function stressTests(input: DisasterInput): { tests: StressTest[]; survived: number; summary: string } {
  const cash = dec(input.baseline.months[input.baseline.months.length - 1]?.cash ?? 0);
  const scale = input.baseline.scale;
  const topCustomer = [...input.customers].sort((a, b) => dec(b.monthlyRevenue).plus(b.balance).comparedTo(dec(a.monthlyRevenue).plus(a.balance)))[0];
  const topSupplier = [...input.suppliers].sort((a, b) => dec(b.monthlySpend).comparedTo(a.monthlySpend))[0];
  const candidates: { key: string; title: string; description: string; shocks: DisasterShock[] }[] = [];
  const customerDefault: DisasterShock | null = topCustomer && dec(topCustomer.monthlyRevenue).plus(topCustomer.balance).gt(0) ? { kind: 'CUSTOMER_DEFAULT', contactId: topCustomer.contactId, writeOffPercent: '100', loseFutureSales: true } : null;
  if (customerDefault) candidates.push({ key: 'LARGEST_CUSTOMER_DEFAULTS', title: `Largest customer defaults (${topCustomer!.name})`, description: 'Never pays what it owes and stops buying.', shocks: [customerDefault] });
  if (topSupplier && dec(topSupplier.monthlySpend).gt(0)) {
    candidates.push({ key: 'LARGEST_SUPPLIER_FAILS', title: `Largest supplier fails (${topSupplier.name})`, description: '25% of sales lost for 2 months, then the replacement costs 10% more.', shocks: [{ kind: 'SUPPLIER_FAILURE', contactId: topSupplier.contactId, disruptionMonths: 2, revenueLostPercent: '25', replacementPremiumPercent: '10' }] });
  }
  candidates.push({ key: 'ONE_MONTH_SHUTDOWN', title: 'Operations stop for a month', description: 'No sales for one month while payroll and running costs carry on.', shocks: [{ kind: 'OPERATIONAL_DISRUPTION', revenueLostPercent: '100', months: 1, recoveryCost: '0', insuranceRecovery: '0', insuranceMonthsLater: 0 }] });
  candidates.push({ key: 'DEMAND_DOWN_30', title: 'Sales fall 30% for six months', description: 'Customers also take 15 more days to pay.', shocks: [{ kind: 'DEMAND_SHOCK', revenueLostPercent: '30', months: 6, extraCollectionDays: 15 }] });
  candidates.push({ key: 'CUSTOMERS_PAY_LATE', title: 'Customers pay 30 days later', description: 'For six months, then back to normal.', shocks: [{ kind: 'LIQUIDITY_SHOCK', frozenCash: '0', frozenMonths: 1, creditWithdrawn: '0', collectionDelayDays: 30, delayMonths: 6 }] });
  if (cash.gt(0)) {
    const half = cash.div(2).toDecimalPlaces(scale, D.ROUND_DOWN);
    candidates.push({ key: 'HALF_CASH_FROZEN', title: 'Half the cash frozen for three months', description: 'A bank failure or a court order freezes half of today’s balance.', shocks: [{ kind: 'LIQUIDITY_SHOCK', frozenCash: half.toFixed(scale), frozenMonths: 3, creditWithdrawn: '0', collectionDelayDays: 0, delayMonths: 1 }] });
  }
  if (customerDefault) {
    candidates.push({ key: 'PERFECT_STORM', title: 'Perfect storm', description: 'The largest customer defaults while sales fall 30% for six months.', shocks: [customerDefault, { kind: 'DEMAND_SHOCK', revenueLostPercent: '30', months: 6, extraCollectionDays: 15 }] });
  }
  const tests = candidates.map((c) => ({ ...c, impact: simulateDisaster({ ...input, shocks: c.shocks }).impact }));
  tests.sort((a, b) => dec(a.impact.lowestCash.amount).comparedTo(b.impact.lowestCash.amount));
  const survived = tests.filter((t) => t.impact.verdict === 'SURVIVES').length;
  const runsOut = tests.filter((t) => t.impact.verdict === 'RUNS_OUT');
  const summary = `The business gets through ${survived} of ${tests.length} standard shocks without cash falling below the minimum balance.${runsOut.length ? ` Cash runs out in ${runsOut.length}: ${runsOut.map((t) => t.title.replace(/ \(.*\)$/, '').toLowerCase()).join('; ')}.` : ''}`;
  return { tests, survived, summary };
}
