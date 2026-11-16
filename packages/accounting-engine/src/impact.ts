import { monthLabel } from './cfo';
import { D, type Dec } from './money';
import { checkDriver, runTwin, shiftYm, TwinError, type TwinBaseline, type TwinDriverWithMeta, type TwinProjection } from './twin';

/**
 * Business impact engine: how a change in sales, HR, procurement or operations flows through to
 * the financial statements. Each business change ("lever") is turned into ordinary digital-twin
 * changes built from the organisation's own figures (its cost of sales as a share of revenue,
 * its customers' sales and its suppliers' bills), and played forward from the posted books
 * against the business carrying on as it is.
 *
 * Everything is measured by running the model, never estimated by a rule of thumb:
 *  - the combined effect of all the changes;
 *  - each change on its own, with the lines of the statements it moves (the chain from the
 *    business change to profit and cash);
 *  - each business area's changes together on their own; when areas interact (a price rise on
 *    top of a new customer, say) the difference from the combined effect is reported as
 *    interaction rather than hidden.
 */

export const IMPACT_AREAS = ['SALES', 'HR', 'PROCUREMENT', 'OPERATIONS'] as const;
export type ImpactArea = (typeof IMPACT_AREAS)[number];

export const IMPACT_AREA_LABEL: Record<ImpactArea, string> = { SALES: 'Sales', HR: 'People (HR)', PROCUREMENT: 'Procurement', OPERATIONS: 'Operations' };

export const IMPACT_LEVERS = [
  'NEW_CUSTOMER',
  'LOSE_CUSTOMER',
  'PRICE_CHANGE',
  'SALES_HIRES',
  'CUSTOMER_TERMS',
  'HIRE',
  'PAY_RISE',
  'HEADCOUNT_REDUCTION',
  'SUPPLIER_PRICE',
  'SUPPLIER_TERMS',
  'NEW_SITE',
  'EQUIPMENT',
  'RUNNING_COSTS',
] as const;
export type ImpactLever = (typeof IMPACT_LEVERS)[number];

export const LEVER_INFO: Record<ImpactLever, { area: ImpactArea; label: string; description: string }> = {
  NEW_CUSTOMER: { area: 'SALES', label: 'Win a new customer or contract', description: 'New monthly sales that build up over a few months, with the cost of sales they bring.' },
  LOSE_CUSTOMER: { area: 'SALES', label: 'Lose an existing customer', description: 'Sales to a customer from the books stop, with the cost of those sales.' },
  PRICE_CHANGE: { area: 'SALES', label: 'Change prices', description: 'Raise or cut prices, with the change in sales volume you expect in response.' },
  SALES_HIRES: { area: 'SALES', label: 'Add salespeople', description: 'People who cost money from the day they join and bring in sales as they ramp up.' },
  CUSTOMER_TERMS: { area: 'SALES', label: 'Change customer payment terms', description: 'Give customers more or fewer days to pay.' },
  HIRE: { area: 'HR', label: 'Hire people', description: 'New staff at a monthly cost each, with an optional one-off cost (recruitment, equipment).' },
  PAY_RISE: { area: 'HR', label: 'Pay rise', description: 'Raise (or cut) the whole payroll by a percentage.' },
  HEADCOUNT_REDUCTION: { area: 'HR', label: 'Reduce headcount', description: 'People leave: their monthly cost stops, with a one-off severance cost.' },
  SUPPLIER_PRICE: { area: 'PROCUREMENT', label: 'Supplier price change', description: 'One supplier, or all suppliers, charge more or less; the change applies to the share of cost of sales they supply.' },
  SUPPLIER_TERMS: { area: 'PROCUREMENT', label: 'Change supplier payment terms', description: 'Pay suppliers sooner or later.' },
  NEW_SITE: { area: 'OPERATIONS', label: 'Open a site, branch or line', description: 'Set-up cost, monthly running cost, and revenue that builds up, with its cost of sales.' },
  EQUIPMENT: { area: 'OPERATIONS', label: 'Buy equipment or automation', description: 'Paid up front and depreciated over its life, saving running costs every month.' },
  RUNNING_COSTS: { area: 'OPERATIONS', label: 'Change running costs', description: 'Rent, utilities, software and other operating costs up or down, by a percentage or an amount a month.' },
};

/** Month numbers are 1-based offsets into the projection (1 = the first projected month). */
export type ImpactChange =
  | { lever: 'NEW_CUSTOMER'; label?: string | null; monthlyRevenue: string; rampMonths: number; month?: number }
  | { lever: 'LOSE_CUSTOMER'; contactId: string; month?: number }
  | { lever: 'PRICE_CHANGE'; pricePercent: string; volumePercent: string; month?: number }
  | { lever: 'SALES_HIRES'; count: number; monthlyCostPerHead: string; oneOffCostPerHead: string; monthlyRevenuePerHead: string; rampMonths: number; month?: number }
  | { lever: 'CUSTOMER_TERMS'; collectionDaysChange: number; month?: number }
  | { lever: 'HIRE'; count: number; monthlyCostPerHead: string; oneOffCostPerHead: string; month?: number }
  | { lever: 'PAY_RISE'; percent: string; month?: number }
  | { lever: 'HEADCOUNT_REDUCTION'; count: number; monthlyCostPerHead: string; severancePerHead: string; month?: number }
  | { lever: 'SUPPLIER_PRICE'; contactId: string | null; percent: string; month?: number }
  | { lever: 'SUPPLIER_TERMS'; paymentDaysChange: number; month?: number }
  | { lever: 'NEW_SITE'; label?: string | null; oneOffCost: string; monthlyCost: string; monthlyRevenue: string; rampMonths: number; month?: number }
  | { lever: 'EQUIPMENT'; label?: string | null; cost: string; usefulLifeMonths: number; monthlySaving: string; month?: number }
  | { lever: 'RUNNING_COSTS'; percent: string; monthlyAmount: string; month?: number };

export interface ImpactCustomer {
  contactId: string;
  name: string;
  /** Average monthly sales to the customer in the baseline months. */
  monthlyRevenue: string;
}
export interface ImpactSupplier {
  contactId: string;
  name: string;
  /** Average monthly bills from the supplier in the baseline months. */
  monthlySpend: string;
}

export interface ImpactInput {
  baseline: TwinBaseline;
  horizonMonths: number;
  cashBuffer?: string | null;
  customers: readonly ImpactCustomer[];
  suppliers: readonly ImpactSupplier[];
}

/** Figures for one projection over the horizon. */
export interface ImpactFigures {
  revenue: string;
  grossProfit: string;
  grossMarginPercent: string | null;
  /** Gross profit less payroll, other operating costs and depreciation. */
  operatingProfit: string;
  operatingMarginPercent: string | null;
  netProfit: string;
  netMarginPercent: string | null;
  closingCash: string;
  lowestCash: { amount: string; month: string };
  cashNegativeFrom: string | null;
  cashRequired: string;
  /** People added by the end of the horizon (hires less leavers modelled as a payroll change are not counted). */
  headcountAdded: number;
}

/** After minus before, for the money figures and the margins (in percentage points). */
export interface ImpactDelta {
  revenue: string;
  grossProfit: string;
  grossMarginPoints: string | null;
  operatingProfit: string;
  operatingMarginPoints: string | null;
  netProfit: string;
  netMarginPoints: string | null;
  closingCash: string;
  lowestCash: string;
}

/** When the money a change costs up front comes back, measured on cash against carrying on as is. */
export interface ImpactPayback {
  status: 'NO_OUTLAY' | 'PAYS_BACK' | 'NOT_WITHIN' | 'NEVER_AHEAD';
  /** The deepest the change takes cash below carrying on as is (zero or negative), and when. */
  deepest: { amount: string; month: string };
  /** The first month cash is back level with or ahead of carrying on as is, after being behind. */
  month: string | null;
}

export interface ImpactLine {
  key: 'revenue' | 'costOfSales' | 'grossProfit' | 'payroll' | 'otherOperating' | 'oneOffItems' | 'depreciation' | 'interest' | 'tax' | 'netProfit' | 'receivables' | 'payables' | 'investment' | 'closingCash';
  label: string;
  /** Total over the horizon for profit lines, the balance at the end for receivables and payables. */
  change: string;
}

export interface ImpactChangeResult {
  index: number;
  lever: ImpactLever;
  area: ImpactArea;
  title: string;
  /** How the change was turned into figures, in words. */
  explanation: string[];
  drivers: TwinDriverWithMeta[];
  /** The change on its own, against carrying on as is. */
  alone: ImpactDelta;
  payback: ImpactPayback;
  /** The lines of the statements the change moves, biggest first. */
  lines: ImpactLine[];
}

export interface ImpactAreaResult {
  area: ImpactArea;
  label: string;
  changes: number[];
  /** The area's changes together, on their own. */
  alone: ImpactDelta;
}

export interface ImpactMonth {
  month: string;
  revenueBefore: string;
  revenueAfter: string;
  netProfitBefore: string;
  netProfitAfter: string;
  cashBefore: string;
  cashAfter: string;
}

export interface ImpactResult {
  /** Cost of sales as a share of revenue in the baseline months, used for new revenue. */
  costOfSalesPercent: string;
  before: ImpactFigures;
  after: ImpactFigures;
  change: ImpactDelta;
  payback: ImpactPayback;
  changes: ImpactChangeResult[];
  areas: ImpactAreaResult[];
  /** Combined effect less the sum of the areas on their own. */
  interaction: { netProfit: string; closingCash: string };
  months: ImpactMonth[];
  assumptions: string[];
  summary: string;
}

const NUM = /^-?\d{1,14}(\.\d{1,6})?$/;
const dec = (v: string | Dec) => new D(v);
const pct = (v: string) => dec(v).div(100);

/** Average monthly revenue, cost of sales and payroll in the baseline. */
function averages(b: TwinBaseline) {
  const n = b.months.length || 1;
  const avg = (k: 'revenue' | 'costOfSales' | 'payroll') => b.months.reduce((a, m) => a.plus(m[k]), new D(0)).div(n);
  return { revenue: avg('revenue'), costOfSales: avg('costOfSales'), payroll: avg('payroll') };
}

/** Cost of sales as a percentage of revenue in the baseline, between 0 and 100. */
export function costOfSalesShare(b: TwinBaseline): Dec {
  const a = averages(b);
  if (a.revenue.lte(0)) return new D(0);
  return D.min(D.max(a.costOfSales.div(a.revenue).times(100), 0), 100).toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** Problems with a change, in words. Empty when it is fine. */
export function checkChange(c: ImpactChange, horizon: number, ctx: Pick<ImpactInput, 'customers' | 'suppliers' | 'baseline'>): string[] {
  const issues: string[] = [];
  const num = (v: unknown, label: string, min?: number, max?: number) => {
    if (typeof v !== 'string' || !NUM.test(v)) return issues.push(`${label}: enter a number`);
    const x = dec(v);
    if (min !== undefined && x.lt(min)) issues.push(`${label} must be at least ${min}`);
    if (max !== undefined && x.gt(max)) issues.push(`${label} must be at most ${max}`);
  };
  const positive = (v: unknown, label: string) => {
    if (typeof v !== 'string' || !NUM.test(v)) return issues.push(`${label}: enter a number`);
    if (dec(v).lte(0)) issues.push(`${label} must be above zero`);
  };
  const int = (v: unknown, label: string, min: number, max: number) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) issues.push(`${label} must be a whole number from ${min} to ${max}`);
  };
  const label = (v: unknown) => {
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 80)) issues.push('Keep the description under 80 characters');
  };
  if (c.month !== undefined) int(c.month, 'Month it starts', 1, horizon);
  switch (c.lever) {
    case 'NEW_CUSTOMER':
      label(c.label);
      positive(c.monthlyRevenue, 'Monthly sales at full speed');
      int(c.rampMonths, 'Months to reach full speed', 1, 60);
      break;
    case 'LOSE_CUSTOMER':
      if (!ctx.customers.some((x) => x.contactId === c.contactId)) issues.push('Choose a customer from the list');
      else if (dec(ctx.customers.find((x) => x.contactId === c.contactId)!.monthlyRevenue).lte(0)) issues.push('That customer had no sales in the baseline months, so there is nothing to lose');
      break;
    case 'PRICE_CHANGE': {
      const before = issues.length;
      num(c.pricePercent, 'Price change (%)', -90, 500);
      num(c.volumePercent, 'Change in sales volume (%)', -100, 500);
      if (issues.length === before && dec(c.pricePercent).isZero() && dec(c.volumePercent).isZero()) issues.push('Enter a price change or a volume change');
      break;
    }
    case 'SALES_HIRES':
      int(c.count, 'Salespeople added', 1, 1000);
      positive(c.monthlyCostPerHead, 'Monthly cost per person');
      num(c.oneOffCostPerHead, 'One-off cost per person', 0);
      num(c.monthlyRevenuePerHead, 'Monthly sales per person at full speed', 0);
      int(c.rampMonths, 'Months to reach full speed', 1, 60);
      break;
    case 'CUSTOMER_TERMS':
      int(c.collectionDaysChange, 'Change in days customers take to pay', -365, 365);
      if (c.collectionDaysChange === 0) issues.push('Enter how many days sooner (negative) or later customers pay');
      break;
    case 'HIRE':
      int(c.count, 'People hired', 1, 10000);
      positive(c.monthlyCostPerHead, 'Monthly cost per person');
      num(c.oneOffCostPerHead, 'One-off cost per person', 0);
      break;
    case 'PAY_RISE':
      num(c.percent, 'Pay change (%)', -50, 100);
      if (typeof c.percent === 'string' && NUM.test(c.percent) && dec(c.percent).isZero()) issues.push('Enter the pay change');
      if (averages(ctx.baseline).payroll.lte(0)) issues.push('There is no payroll in the baseline months to change');
      break;
    case 'HEADCOUNT_REDUCTION': {
      const before = issues.length;
      int(c.count, 'People leaving', 1, 10000);
      positive(c.monthlyCostPerHead, 'Monthly cost per person');
      num(c.severancePerHead, 'Severance per person', 0);
      if (issues.length === before && new D(c.monthlyCostPerHead).times(c.count).gt(averages(ctx.baseline).payroll)) issues.push('The people leaving cost more than the whole payroll in the baseline months');
      break;
    }
    case 'SUPPLIER_PRICE':
      if (c.contactId !== null && !ctx.suppliers.some((x) => x.contactId === c.contactId)) issues.push('Choose a supplier from the list, or all suppliers');
      num(c.percent, 'Supplier price change (%)', -90, 500);
      if (typeof c.percent === 'string' && NUM.test(c.percent) && dec(c.percent).isZero()) issues.push('Enter the price change');
      break;
    case 'SUPPLIER_TERMS':
      int(c.paymentDaysChange, 'Change in days you take to pay suppliers', -365, 365);
      if (c.paymentDaysChange === 0) issues.push('Enter how many days sooner (negative) or later suppliers are paid');
      break;
    case 'NEW_SITE':
      label(c.label);
      num(c.oneOffCost, 'Set-up cost', 0);
      num(c.monthlyCost, 'Monthly running cost', 0);
      num(c.monthlyRevenue, 'Monthly sales at full speed', 0);
      int(c.rampMonths, 'Months to reach full speed', 1, 60);
      break;
    case 'EQUIPMENT':
      label(c.label);
      positive(c.cost, 'Cost');
      int(c.usefulLifeMonths, 'Useful life in months', 1, 1200);
      num(c.monthlySaving, 'Running costs saved a month', 0);
      break;
    case 'RUNNING_COSTS': {
      const before = issues.length;
      num(c.percent, 'Change (%)', -100, 1000);
      num(c.monthlyAmount, 'Change a month (negative saves)');
      if (issues.length === before && dec(c.percent).isZero() && dec(c.monthlyAmount).isZero()) issues.push('Enter a percentage or an amount a month');
      break;
    }
    default:
      issues.push('Unknown kind of change');
  }
  return issues;
}

/** One change as twin changes, with the explanation in words. */
export function changeDrivers(c: ImpactChange, input: ImpactInput): { title: string; explanation: string[]; drivers: TwinDriverWithMeta[] } {
  const H = input.horizonMonths;
  const scale = input.baseline.scale;
  const cur = input.baseline.currency;
  const m = c.month ?? 1;
  const last = input.baseline.months[input.baseline.months.length - 1]?.month ?? '';
  const monthName = (i: number) => monthLabel(shiftYm(shiftYm(last, 1), i - 1));
  const money = (v: Dec | string) => `${cur} ${dec(v).abs().toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale)}`;
  const avg = averages(input.baseline);
  const cosPct = costOfSalesShare(input.baseline);
  const drivers: TwinDriverWithMeta[] = [];
  const explanation: string[] = [];
  let title: string = LEVER_INFO[c.lever].label;
  const cosLine = (rev: string) => (cosPct.gt(0) ? ` Cost of sales follows at ${cosPct.toFixed(2)}% of that revenue, the business’s own ratio, so gross profit rises ${money(dec(rev).times(new D(100).minus(cosPct)).div(100))} a month at full speed.` : '');
  switch (c.lever) {
    case 'NEW_CUSTOMER': {
      title = c.label?.trim() ? `New customer: ${c.label.trim()}` : 'Win a new customer';
      drivers.push({ kind: 'EXPANSION', label: title, oneOffCost: '0', monthlyCost: '0', monthlyRevenue: dec(c.monthlyRevenue).toFixed(), rampMonths: c.rampMonths, month: m, costOfSalesPercent: cosPct.toFixed(2) });
      explanation.push(`Sales start in ${monthName(m)} and build up evenly to ${money(c.monthlyRevenue)} a month over ${c.rampMonths} month${c.rampMonths === 1 ? '' : 's'}.${cosLine(c.monthlyRevenue)}`);
      explanation.push('The new customer pays in the business’s usual number of days, so receivables rise with the sales.');
      break;
    }
    case 'LOSE_CUSTOMER': {
      const k = input.customers.find((x) => x.contactId === c.contactId)!;
      title = `Lose ${k.name}`;
      const share = avg.revenue.gt(0) ? D.min(dec(k.monthlyRevenue).div(avg.revenue).times(100), 100).toDecimalPlaces(2, D.ROUND_HALF_UP) : new D(0);
      drivers.push({ kind: 'DOWNTURN', label: title, revenuePercent: share.toFixed(2), extraCollectionDays: 0, fromMonth: m });
      explanation.push(`${k.name} bought ${money(k.monthlyRevenue)} a month in the baseline months, ${share.toFixed(2)}% of revenue. Those sales stop from ${monthName(m)}, and so does the cost of those sales; payroll and running costs carry on.`);
      break;
    }
    case 'PRICE_CHANGE': {
      const p = dec(c.pricePercent);
      title = p.isZero() ? `Sales volume ${dec(c.volumePercent).gte(0) ? 'up' : 'down'} ${dec(c.volumePercent).abs().toFixed()}%` : `Prices ${p.gt(0) ? 'up' : 'down'} ${p.abs().toFixed()}%`;
      drivers.push({ kind: 'PRICE_CHANGE', label: title, pricePercent: p.toFixed(), volumePercent: dec(c.volumePercent).toFixed(), fromMonth: m });
      explanation.push(`From ${monthName(m)} prices change ${p.toFixed()}% and sales volume ${dec(c.volumePercent).toFixed()}%. A price change moves revenue but not the cost of each sale; a volume change moves both.`);
      break;
    }
    case 'SALES_HIRES': {
      title = `Add ${c.count} salesperson${c.count === 1 ? '' : 's'}`.replace('salespersons', 'salespeople');
      drivers.push({ kind: 'HIRING', label: title, count: c.count, monthlyCostPerHead: dec(c.monthlyCostPerHead).toFixed(), oneOffCostPerHead: dec(c.oneOffCostPerHead).toFixed(), fromMonth: m });
      explanation.push(`${c.count} ${c.count === 1 ? 'person joins' : 'people join'} in ${monthName(m)} at ${money(c.monthlyCostPerHead)} a month each${dec(c.oneOffCostPerHead).gt(0) ? `, plus ${money(c.oneOffCostPerHead)} each once` : ''}.`);
      const rev = dec(c.monthlyRevenuePerHead).times(c.count);
      if (rev.gt(0)) {
        drivers.push({ kind: 'EXPANSION', label: `Sales from ${title.toLowerCase().replace(/^add /, 'the new ')}`, oneOffCost: '0', monthlyCost: '0', monthlyRevenue: rev.toFixed(), rampMonths: c.rampMonths, month: m, costOfSalesPercent: cosPct.toFixed(2) });
        explanation.push(`They bring in sales rising evenly to ${money(rev)} a month over ${c.rampMonths} month${c.rampMonths === 1 ? '' : 's'}.${cosLine(rev.toFixed())}`);
      } else explanation.push('No extra sales are assumed from them.');
      break;
    }
    case 'CUSTOMER_TERMS': {
      const d = c.collectionDaysChange;
      title = `Customers pay ${Math.abs(d)} days ${d > 0 ? 'later' : 'sooner'}`;
      drivers.push({ kind: 'WORKING_CAPITAL', label: title, collectionDaysChange: d, paymentDaysChange: 0, fromMonth: m });
      explanation.push(`From ${monthName(m)} customers take ${Math.abs(d)} days ${d > 0 ? 'longer' : 'less'} to pay. Profit does not change; receivables ${d > 0 ? 'rise' : 'fall'} by about ${Math.abs(d)} days of sales, which ${d > 0 ? 'ties up' : 'frees'} that much cash.`);
      break;
    }
    case 'HIRE': {
      title = `Hire ${c.count} ${c.count === 1 ? 'person' : 'people'}`;
      drivers.push({ kind: 'HIRING', label: title, count: c.count, monthlyCostPerHead: dec(c.monthlyCostPerHead).toFixed(), oneOffCostPerHead: dec(c.oneOffCostPerHead).toFixed(), fromMonth: m });
      explanation.push(`${c.count} ${c.count === 1 ? 'person joins' : 'people join'} in ${monthName(m)} at ${money(c.monthlyCostPerHead)} a month each, adding ${money(dec(c.monthlyCostPerHead).times(c.count))} a month to payroll${dec(c.oneOffCostPerHead).gt(0) ? `, plus a one-off ${money(dec(c.oneOffCostPerHead).times(c.count))} in running costs` : ''}. No extra sales are assumed.`);
      break;
    }
    case 'PAY_RISE': {
      const p = dec(c.percent);
      title = `Pay ${p.gt(0) ? 'rise' : 'cut'} of ${p.abs().toFixed()}%`;
      drivers.push({ kind: 'EXPENSE_CHANGE', label: title, target: 'PAYROLL', percent: p.toFixed(), fromMonth: m });
      explanation.push(`From ${monthName(m)} payroll changes ${p.toFixed()}%: about ${money(avg.payroll.times(p).div(100))} a month on today’s ${money(avg.payroll)}.`);
      break;
    }
    case 'HEADCOUNT_REDUCTION': {
      title = `${c.count} ${c.count === 1 ? 'person leaves' : 'people leave'}`;
      const saving = dec(c.monthlyCostPerHead).times(c.count);
      drivers.push({ kind: 'EXPENSE_CHANGE', label: title, target: 'PAYROLL', monthlyAmount: saving.negated().toFixed(), fromMonth: m });
      explanation.push(`From ${monthName(m)} payroll falls ${money(saving)} a month.`);
      const sev = dec(c.severancePerHead).times(c.count).toDecimalPlaces(scale, D.ROUND_HALF_UP);
      if (sev.gt(0)) {
        drivers.push({ kind: 'ONE_OFF', label: 'Severance', amount: sev.negated().toFixed(scale), month: m, affectsProfit: true });
        explanation.push(`Severance of ${money(sev)} is paid in ${monthName(m)}, through profit.`);
      }
      explanation.push('Sales are assumed not to change; if the people leaving bring in sales, add that loss as a separate change.');
      break;
    }
    case 'SUPPLIER_PRICE': {
      const p = dec(c.percent);
      if (c.contactId === null) {
        title = `All suppliers ${p.gt(0) ? 'up' : 'down'} ${p.abs().toFixed()}%`;
        drivers.push({ kind: 'SUPPLIER_COST', label: title, percent: p.toFixed(), fromMonth: m });
        explanation.push(`From ${monthName(m)} cost of sales changes ${p.toFixed()}%: about ${money(avg.costOfSales.times(p).div(100))} a month on today’s ${money(avg.costOfSales)}.`);
      } else {
        const s = input.suppliers.find((x) => x.contactId === c.contactId)!;
        title = `${s.name} ${p.gt(0) ? 'up' : 'down'} ${p.abs().toFixed()}%`;
        const share = avg.costOfSales.gt(0) ? D.min(dec(s.monthlySpend).div(avg.costOfSales), 1) : new D(0);
        const eff = p.times(share).toDecimalPlaces(4, D.ROUND_HALF_UP);
        if (eff.isZero()) {
          explanation.push(`There is no cost of sales in the baseline months for ${s.name}’s price to apply to, so nothing changes.`);
        } else {
          drivers.push({ kind: 'SUPPLIER_COST', label: title, percent: eff.toFixed(), fromMonth: m });
          explanation.push(`${s.name} billed ${money(s.monthlySpend)} a month, about ${share.times(100).toFixed(1)}% of cost of sales. Its ${p.toFixed()}% price change moves cost of sales ${eff.toFixed(2)}% from ${monthName(m)}.`);
        }
      }
      break;
    }
    case 'SUPPLIER_TERMS': {
      const d = c.paymentDaysChange;
      title = `Pay suppliers ${Math.abs(d)} days ${d > 0 ? 'later' : 'sooner'}`;
      drivers.push({ kind: 'WORKING_CAPITAL', label: title, collectionDaysChange: 0, paymentDaysChange: d, fromMonth: m });
      explanation.push(`From ${monthName(m)} suppliers are paid ${Math.abs(d)} days ${d > 0 ? 'later' : 'sooner'}. Profit does not change; payables ${d > 0 ? 'rise' : 'fall'} by about ${Math.abs(d)} days of costs, which ${d > 0 ? 'keeps' : 'uses'} that much cash.`);
      break;
    }
    case 'NEW_SITE': {
      title = c.label?.trim() ? `Open ${c.label.trim()}` : 'Open a new site';
      drivers.push({ kind: 'EXPANSION', label: title, oneOffCost: dec(c.oneOffCost).toFixed(), monthlyCost: dec(c.monthlyCost).toFixed(), monthlyRevenue: dec(c.monthlyRevenue).toFixed(), rampMonths: c.rampMonths, month: m, costOfSalesPercent: cosPct.toFixed(2) });
      explanation.push(`It opens in ${monthName(m)}, costing ${money(c.oneOffCost)} to set up and ${money(c.monthlyCost)} a month to run.`);
      if (dec(c.monthlyRevenue).gt(0)) explanation.push(`Its sales build up evenly to ${money(c.monthlyRevenue)} a month over ${c.rampMonths} month${c.rampMonths === 1 ? '' : 's'}.${cosLine(c.monthlyRevenue)}`);
      else explanation.push('No sales are assumed from it.');
      break;
    }
    case 'EQUIPMENT': {
      title = c.label?.trim() ? `Buy ${c.label.trim()}` : 'Buy equipment';
      drivers.push({ kind: 'INVESTMENT', label: title, amount: dec(c.cost).toFixed(), usefulLifeMonths: c.usefulLifeMonths, month: m });
      explanation.push(`${money(c.cost)} is paid in ${monthName(m)} and depreciated over ${c.usefulLifeMonths} months: ${money(dec(c.cost).div(c.usefulLifeMonths))} a month through profit, from the month after.`);
      if (dec(c.monthlySaving).gt(0)) {
        drivers.push({ kind: 'EXPENSE_CHANGE', label: `Savings from ${title.replace(/^Buy /, '')}`, target: 'OPERATING', monthlyAmount: dec(c.monthlySaving).negated().toFixed(), fromMonth: Math.min(m + 1, H) });
        explanation.push(`It saves ${money(c.monthlySaving)} a month in running costs from ${monthName(Math.min(m + 1, H))}.`);
      }
      break;
    }
    case 'RUNNING_COSTS': {
      const p = dec(c.percent);
      const a = dec(c.monthlyAmount);
      const parts = [p.isZero() ? null : `${p.toFixed()}%`, a.isZero() ? null : `${a.gt(0) ? '+' : '−'}${money(a)} a month`].filter(Boolean);
      const lower = p.lte(0) && a.lte(0);
      title = `Running costs ${parts.join(' and ')}`;
      drivers.push({ kind: 'EXPENSE_CHANGE', label: title, target: 'OPERATING', ...(p.isZero() ? {} : { percent: p.toFixed() }), ...(a.isZero() ? {} : { monthlyAmount: a.toFixed() }), fromMonth: m });
      explanation.push(`From ${monthName(m)} running costs other than payroll ${lower ? 'fall' : 'change'} by ${parts.join(' and ')}.`);
      break;
    }
  }
  for (const d of drivers) {
    const bad = checkDriver(d, H);
    if (bad.length) throw new TwinError('A change could not be turned into figures', bad);
  }
  return { title, explanation, drivers };
}

function figures(p: TwinProjection, scale: number): ImpactFigures {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const sum = (fn: (m: TwinProjection['months'][number]) => Dec) => p.months.reduce((a, m) => a.plus(fn(m)), new D(0));
  const revenue = sum((m) => dec(m.revenue));
  const gross = sum((m) => dec(m.grossProfit));
  const operating = sum((m) => dec(m.grossProfit).minus(m.payroll).minus(m.otherOperating).minus(m.depreciation));
  const net = sum((m) => dec(m.netProfit));
  const margin = (x: Dec) => (revenue.gt(0) ? x.div(revenue).times(100).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2) : null);
  return {
    revenue: f(revenue),
    grossProfit: f(gross),
    grossMarginPercent: margin(gross),
    operatingProfit: f(operating),
    operatingMarginPercent: margin(operating),
    netProfit: f(net),
    netMarginPercent: margin(net),
    closingCash: p.closingCash,
    lowestCash: p.minimumCash,
    cashNegativeFrom: p.cashNegativeFrom,
    cashRequired: p.cashRequired,
    headcountAdded: p.months[p.months.length - 1]?.headcountAdded ?? 0,
  };
}

function delta(a: ImpactFigures, b: ImpactFigures, scale: number): ImpactDelta {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const d = (x: string, y: string) => f(dec(x).minus(y));
  const pts = (x: string | null, y: string | null) => (x === null || y === null ? null : dec(x).minus(y).toFixed(2));
  return {
    revenue: d(a.revenue, b.revenue),
    grossProfit: d(a.grossProfit, b.grossProfit),
    grossMarginPoints: pts(a.grossMarginPercent, b.grossMarginPercent),
    operatingProfit: d(a.operatingProfit, b.operatingProfit),
    operatingMarginPoints: pts(a.operatingMarginPercent, b.operatingMarginPercent),
    netProfit: d(a.netProfit, b.netProfit),
    netMarginPoints: pts(a.netMarginPercent, b.netMarginPercent),
    closingCash: d(a.closingCash, b.closingCash),
    lowestCash: d(a.lowestCash.amount, b.lowestCash.amount),
  };
}

function payback(base: TwinProjection, after: TwinProjection, scale: number): ImpactPayback {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  const gaps = after.months.map((m, k) => ({ month: m.month, gap: dec(m.closingCash).minus(base.months[k]!.closingCash) }));
  const deepest = gaps.reduce((a, g) => (g.gap.lt(a.gap) ? g : a), { month: gaps[0]!.month, gap: new D(0) });
  // Rounding noise of a fraction of the smallest unit does not count as an outlay.
  const tiny = new D(10).pow(-scale);
  if (deepest.gap.gt(tiny.negated())) return { status: 'NO_OUTLAY', deepest: { amount: f(new D(0)), month: gaps[0]!.month }, month: null };
  const k = gaps.findIndex((g) => g.month === deepest.month);
  const back = gaps.slice(k + 1).find((g) => g.gap.gte(0));
  if (back) return { status: 'PAYS_BACK', deepest: { amount: f(deepest.gap), month: deepest.month }, month: back.month };
  const lastGap = gaps[gaps.length - 1]!.gap;
  // Still behind at the end: either recovering (behind by less than at the worst) or never catching up.
  const recovering = lastGap.gt(deepest.gap) && gaps.slice(k + 1).length > 0;
  return { status: recovering ? 'NOT_WITHIN' : 'NEVER_AHEAD', deepest: { amount: f(deepest.gap), month: deepest.month }, month: null };
}

const LINE_LABEL: Record<ImpactLine['key'], string> = {
  revenue: 'Revenue',
  costOfSales: 'Cost of sales',
  grossProfit: 'Gross profit',
  payroll: 'Payroll',
  otherOperating: 'Other running costs',
  oneOffItems: 'One-off items',
  depreciation: 'Depreciation',
  interest: 'Interest',
  tax: 'Income tax',
  netProfit: 'Net profit',
  receivables: 'Receivables at the end',
  payables: 'Payables at the end',
  investment: 'Spent on equipment',
  closingCash: 'Cash at the end',
};

/** The statement lines a projection moves against the base, in statement order, non-zero only. */
function lines(base: TwinProjection, after: TwinProjection, scale: number): ImpactLine[] {
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP);
  const total = (p: TwinProjection, fn: (m: TwinProjection['months'][number]) => Dec) => p.months.reduce((a, m) => a.plus(fn(m)), new D(0));
  const diff = (fn: (m: TwinProjection['months'][number]) => Dec) => f(total(after, fn).minus(total(base, fn)));
  const end = (k: 'receivables' | 'payables' | 'closingCash') => f(dec(after.months[after.months.length - 1]![k]).minus(base.months[base.months.length - 1]![k]));
  const out: [ImpactLine['key'], Dec][] = [
    ['revenue', diff((m) => dec(m.revenue))],
    ['costOfSales', diff((m) => dec(m.costOfSales))],
    ['grossProfit', diff((m) => dec(m.grossProfit))],
    ['payroll', diff((m) => dec(m.payroll))],
    ['otherOperating', diff((m) => dec(m.otherOperating))],
    ['oneOffItems', diff((m) => dec(m.otherIncome).minus(m.otherExpenses))],
    ['depreciation', diff((m) => dec(m.depreciation))],
    ['interest', diff((m) => dec(m.interest))],
    ['tax', diff((m) => dec(m.tax))],
    ['netProfit', diff((m) => dec(m.netProfit))],
    ['receivables', end('receivables')],
    ['payables', end('payables')],
    ['investment', diff((m) => dec(m.investment))],
    ['closingCash', end('closingCash')],
  ];
  return out.filter(([, v]) => !v.isZero()).map(([key, v]) => ({ key, label: LINE_LABEL[key], change: v.toFixed(scale) }));
}

/** Plays the changes together, each on its own, and each business area on its own, against carrying on as is. */
export function assessImpact(input: ImpactInput & { changes: readonly ImpactChange[] }): ImpactResult {
  const H = input.horizonMonths;
  if (!input.changes.length) throw new TwinError('Add at least one change');
  if (input.changes.length > 15) throw new TwinError('At most 15 changes in an assessment');
  const issues = input.changes.flatMap((c, i) => checkChange(c, H, input).map((m) => `Change ${i + 1}: ${m}`));
  if (issues.length) throw new TwinError('Some changes need fixing', issues);
  const scale = input.baseline.scale;
  const run = (drivers: TwinDriverWithMeta[]) => runTwin({ baseline: input.baseline, drivers, horizonMonths: H, cashBuffer: input.cashBuffer });
  const baseRun = run([]);
  const base = baseRun.projection;
  const built = input.changes.map((c) => changeDrivers(c, input));
  const all = run(built.flatMap((b) => b.drivers));
  const before = figures(base, scale);
  const after = figures(all.projection, scale);

  const changes: ImpactChangeResult[] = built.map((b, i) => {
    const p = run(b.drivers).projection;
    const lever = input.changes[i]!.lever;
    return { index: i + 1, lever, area: LEVER_INFO[lever].area, title: b.title, explanation: b.explanation, drivers: b.drivers, alone: delta(figures(p, scale), before, scale), payback: payback(base, p, scale), lines: lines(base, p, scale) };
  });

  const areas: ImpactAreaResult[] = IMPACT_AREAS.flatMap((area) => {
    const idx = changes.filter((c) => c.area === area).map((c) => c.index);
    if (!idx.length) return [];
    const p = run(idx.flatMap((k) => built[k - 1]!.drivers)).projection;
    return [{ area, label: IMPACT_AREA_LABEL[area], changes: idx, alone: delta(figures(p, scale), before, scale) }];
  });
  const change = delta(after, before, scale);
  const sumAreas = (k: 'netProfit' | 'closingCash') => areas.reduce((a, x) => a.plus(x.alone[k]), new D(0));
  const f = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
  // Monthly figures are rounded to the smallest unit before they are added up, so separate runs can
  // differ by a few of those units; a difference within that rounding is not interaction.
  const noise = new D(10).pow(-scale).times(H).times(areas.length + 1);
  const residue = (x: Dec) => f(x.abs().lte(noise) ? new D(0) : x);
  const interaction = { netProfit: residue(dec(change.netProfit).minus(sumAreas('netProfit'))), closingCash: residue(dec(change.closingCash).minus(sumAreas('closingCash'))) };

  const months: ImpactMonth[] = all.projection.months.map((m, k) => ({
    month: m.month,
    revenueBefore: base.months[k]!.revenue,
    revenueAfter: m.revenue,
    netProfitBefore: base.months[k]!.netProfit,
    netProfitAfter: m.netProfit,
    cashBefore: base.months[k]!.closingCash,
    cashAfter: m.closingCash,
  }));

  const cosPct = costOfSalesShare(input.baseline);
  const assumptions = [
    `Carrying on as is means the average of the ${baseRun.baseline.monthsUsed} posted month${baseRun.baseline.monthsUsed === 1 ? '' : 's'} from ${monthLabel(baseRun.baseline.fromMonth)} to ${monthLabel(baseRun.baseline.toMonth)}, repeated for ${H} months.`,
    `New revenue brings cost of sales at ${cosPct.toFixed(2)}% of it, the business’s own ratio in those months.`,
    `Customers pay in ${baseRun.baseline.collectionDays} days and suppliers are paid in ${baseRun.baseline.paymentDays} days, as in the books, unless a change says otherwise.`,
    baseRun.baseline.taxRateSource === 'NONE' ? 'No income tax was posted in those months, so none is charged on the extra profit.' : `Income tax is ${baseRun.baseline.taxRatePercent}% of profit before tax, from the books.`,
    'Nothing here posts to the books or commits anyone; every projected figure is hypothetical.',
  ];

  const cur = input.baseline.currency;
  const money = (v: string) => `${cur} ${dec(v).abs().toFixed(scale)}`;
  const up = (v: string) => (dec(v).gte(0) ? 'higher' : 'lower');
  const what = changes.length === 1 ? 'This change' : `These ${changes.length} changes together`;
  const verb = changes.length === 1 ? 'leaves' : 'leave';
  const profitPart = dec(change.netProfit).isZero() ? `${verb} net profit unchanged` : `${verb} net profit ${money(change.netProfit)} ${up(change.netProfit)}`;
  const cashPart = dec(change.closingCash).isZero() ? 'cash unchanged' : `cash ${money(change.closingCash)} ${up(change.closingCash)}`;
  const top = [...changes].sort((a, b) => dec(b.alone.netProfit).abs().comparedTo(dec(a.alone.netProfit).abs()))[0]!;
  const driver = changes.length > 1 && !dec(top.alone.netProfit).isZero() ? ` "${top.title}" moves profit most: ${money(top.alone.netProfit)} ${up(top.alone.netProfit)} on its own.` : '';
  const pay = payback(base, all.projection, scale);
  const payText = pay.status === 'PAYS_BACK' ? ` Cash is behind by up to ${money(pay.deepest.amount)} (${monthLabel(pay.deepest.month)}) and is back level by ${monthLabel(pay.month!)}.` : pay.status === 'NOT_WITHIN' ? ` Cash is behind by up to ${money(pay.deepest.amount)} (${monthLabel(pay.deepest.month)}) and has not caught up by the end.` : pay.status === 'NEVER_AHEAD' ? ` Cash stays behind carrying on as is, by ${money(pay.deepest.amount)} at worst (${monthLabel(pay.deepest.month)}).` : '';
  const runOut = after.cashNegativeFrom && !before.cashNegativeFrom ? ` Cash runs out in ${monthLabel(after.cashNegativeFrom)}, which it does not without the changes.` : '';
  const summary = `${what} ${profitPart} over ${H} months, with ${cashPart} at the end.${driver}${payText}${runOut}`;

  return { costOfSalesPercent: cosPct.toFixed(2), before, after, change, payback: pay, changes, areas, interaction, months, assumptions, summary };
}
