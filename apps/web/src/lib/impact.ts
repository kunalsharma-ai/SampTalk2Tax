/** Types and helpers for the business impact engine. */

export type ImpactArea = 'SALES' | 'HR' | 'PROCUREMENT' | 'OPERATIONS';
export type Lever =
  | 'NEW_CUSTOMER'
  | 'LOSE_CUSTOMER'
  | 'PRICE_CHANGE'
  | 'SALES_HIRES'
  | 'CUSTOMER_TERMS'
  | 'HIRE'
  | 'PAY_RISE'
  | 'HEADCOUNT_REDUCTION'
  | 'SUPPLIER_PRICE'
  | 'SUPPLIER_TERMS'
  | 'NEW_SITE'
  | 'EQUIPMENT'
  | 'RUNNING_COSTS';

export type Change =
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

export interface Figures {
  revenue: string;
  grossProfit: string;
  grossMarginPercent: string | null;
  operatingProfit: string;
  operatingMarginPercent: string | null;
  netProfit: string;
  netMarginPercent: string | null;
  closingCash: string;
  lowestCash: { amount: string; month: string };
  cashNegativeFrom: string | null;
  cashRequired: string;
  headcountAdded: number;
}
export interface Delta {
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
export interface Payback { status: 'NO_OUTLAY' | 'PAYS_BACK' | 'NOT_WITHIN' | 'NEVER_AHEAD'; deepest: { amount: string; month: string }; month: string | null }
export interface Line { key: string; label: string; change: string }
export interface ChangeResult { index: number; lever: Lever; area: ImpactArea; title: string; explanation: string[]; drivers: { kind: string; label?: string | null }[]; alone: Delta; payback: Payback; lines: Line[] }
export interface AreaResult { area: ImpactArea; label: string; changes: number[]; alone: Delta }
export interface ImpactMonth { month: string; revenueBefore: string; revenueAfter: string; netProfitBefore: string; netProfitAfter: string; cashBefore: string; cashAfter: string }
export interface ImpactResult {
  costOfSalesPercent: string;
  before: Figures;
  after: Figures;
  change: Delta;
  payback: Payback;
  changes: ChangeResult[];
  areas: AreaResult[];
  interaction: { netProfit: string; closingCash: string };
  months: ImpactMonth[];
  assumptions: string[];
  summary: string;
}
export interface AssessResponse extends ImpactResult { currency: string; actual: { month: string; cash: string }[] }
export interface Options {
  currency: string;
  firstMonth: string;
  areas: { key: ImpactArea; label: string }[];
  levers: { key: Lever; area: ImpactArea; label: string; description: string }[];
  monthly: { revenue: string; costOfSales: string; payroll: string; otherOperating: string };
  costOfSalesPercent: string;
  customers: { contactId: string; name: string; monthlyRevenue: string }[];
  suppliers: { contactId: string; name: string; monthlySpend: string }[];
}
export interface Assessment {
  id: string;
  number: string;
  name: string;
  description: string | null;
  baselineMonths: 3 | 6 | 12;
  horizonMonths: number;
  changes: Change[];
  createdAt: string;
  updatedAt: string;
}
export interface AssessmentItem extends Assessment { areas: ImpactArea[]; netProfitChange: string | null; closingCashChange: string | null }
export interface AssessmentDetail extends Assessment { currency: string; actual: { month: string; cash: string }[]; result: ImpactResult | null; problem: { message: string; issues: string[] } | null }

export const AREA_LABEL: Record<ImpactArea, string> = { SALES: 'Sales', HR: 'People (HR)', PROCUREMENT: 'Procurement', OPERATIONS: 'Operations' };

export const PAYBACK: Record<Payback['status'], string> = {
  NO_OUTLAY: 'No cash outlay',
  PAYS_BACK: 'Pays back',
  NOT_WITHIN: 'Not paid back yet',
  NEVER_AHEAD: 'Cash stays lower',
};

/** A round figure near a share of a monthly amount, for starting values the user is expected to change. */
function about(monthly: string, share: number, fallback: number): string {
  const v = Number(monthly) * share;
  if (!Number.isFinite(v) || v <= 0) return String(fallback);
  const step = 10 ** Math.max(0, Math.floor(Math.log10(v)) - 1);
  return String(Math.max(step, Math.round(v / step) * step));
}

/** A new change of a lever, with starting figures from the business's own size. */
export function newChange(lever: Lever, o: Pick<Options, 'customers' | 'suppliers' | 'monthly'>): Change {
  const m = o.monthly;
  switch (lever) {
    case 'NEW_CUSTOMER':
      return { lever, label: '', monthlyRevenue: about(m.revenue, 0.1, 100000), rampMonths: 3, month: 1 };
    case 'LOSE_CUSTOMER':
      return { lever, contactId: o.customers[0]?.contactId ?? '', month: 1 };
    case 'PRICE_CHANGE':
      return { lever, pricePercent: '5', volumePercent: '-2', month: 1 };
    case 'SALES_HIRES':
      return { lever, count: 1, monthlyCostPerHead: '60000', oneOffCostPerHead: '20000', monthlyRevenuePerHead: '200000', rampMonths: 4, month: 1 };
    case 'CUSTOMER_TERMS':
      return { lever, collectionDaysChange: 15, month: 1 };
    case 'HIRE':
      return { lever, count: 1, monthlyCostPerHead: '50000', oneOffCostPerHead: '15000', month: 1 };
    case 'PAY_RISE':
      return { lever, percent: '8', month: 1 };
    case 'HEADCOUNT_REDUCTION':
      return { lever, count: 1, monthlyCostPerHead: '40000', severancePerHead: '80000', month: 1 };
    case 'SUPPLIER_PRICE':
      return { lever, contactId: o.suppliers[0]?.contactId ?? null, percent: '10', month: 1 };
    case 'SUPPLIER_TERMS':
      return { lever, paymentDaysChange: 15, month: 1 };
    case 'NEW_SITE':
      return { lever, label: '', oneOffCost: about(m.revenue, 2, 1000000), monthlyCost: about(m.otherOperating, 0.3, 100000), monthlyRevenue: about(m.revenue, 0.25, 250000), rampMonths: 6, month: 1 };
    case 'EQUIPMENT':
      return { lever, label: '', cost: about(m.revenue, 1, 500000), usefulLifeMonths: 60, monthlySaving: about(m.otherOperating, 0.05, 15000), month: 1 };
    case 'RUNNING_COSTS':
      return { lever, percent: '-5', monthlyAmount: '0', month: 1 };
  }
}
