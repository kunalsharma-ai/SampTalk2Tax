/** Types and labels for the financial recovery planner. */
import type { Driver, TwinRun } from './twin';

export type RecoveryCategory = 'COLLECTIONS' | 'CASH_CONSERVATION' | 'EXPENSES' | 'SUPPLIERS' | 'FINANCING' | 'REVENUE' | 'RESTRUCTURING';

export const CATEGORY: Record<RecoveryCategory, { label: string; help: string }> = {
  COLLECTIONS: { label: 'Collect faster', help: 'Money customers already owe, and how soon they pay.' },
  CASH_CONSERVATION: { label: 'Conserve cash', help: 'Holding back spending while cash is tight.' },
  EXPENSES: { label: 'Reduce costs', help: 'The largest operating cost lines in your books.' },
  SUPPLIERS: { label: 'Suppliers', help: 'Payment terms and prices with the suppliers you buy most from.' },
  FINANCING: { label: 'Financing', help: 'New money to cover the gap: a loan or new capital.' },
  REVENUE: { label: 'Revenue', help: 'Earning more from what you already sell.' },
  RESTRUCTURING: { label: 'Restructuring', help: 'Modelled only. Decisions about people need advice and care.' },
};
export const CATEGORY_ORDER = Object.keys(CATEGORY) as RecoveryCategory[];

export interface RecoveryEffect { netProfit: string; closingCash: string; minimumCash: string; cashNegativeFrom: string | null; runwayMonths: number | null }
export interface RecoveryTarget { id: string; name: string; amount: string; note: string }
export interface RecoveryOption {
  key: string;
  category: RecoveryCategory;
  title: string;
  detail: string;
  drivers: Driver[];
  targets: RecoveryTarget[];
  risks: string[];
  needsDecision: boolean;
  effect: RecoveryEffect;
}
export interface RecoverySummary {
  closingCash: string;
  minimumCash: { amount: string; month: string };
  cashNegativeFrom: string | null;
  cashRequired: string;
  netProfit: string;
  runwayMonths: number | null;
  cash: { month: string; closingCash: string }[];
}
export interface RecoveryOptions { currency: string; collectionDays: string; paymentDays: string; noAction: RecoverySummary; options: RecoveryOption[]; baselineMonths: number; horizonMonths: number }

export type PlanStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';
export type ActionStatus = 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'DROPPED';
export const PLAN_STATUS: Record<PlanStatus, { label: string; tone: 'neutral' | 'accent' | 'positive' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'accent' },
  CLOSED: { label: 'Closed', tone: 'positive' },
};
export const ACTION_STATUS: Record<ActionStatus, string> = { PLANNED: 'Planned', IN_PROGRESS: 'In progress', DONE: 'Done', DROPPED: 'Dropped' };

export interface RecoveryPlan {
  id: string;
  name: string;
  description: string | null;
  status: PlanStatus;
  baselineMonths: 3 | 6 | 12;
  horizonMonths: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  actions?: { planned: number; inProgress: number; done: number; dropped: number };
}
export interface RecoveryAction {
  id: string;
  optionKey: string;
  category: RecoveryCategory;
  title: string;
  detail: string;
  drivers: Driver[];
  targets: RecoveryTarget[];
  risks: string[];
  needsDecision: boolean;
  status: ActionStatus;
  ownerId: string | null;
  dueDate: string | null;
  note: string | null;
}
export interface RecoveryPlanDetail {
  plan: RecoveryPlan;
  currency: string;
  actions: RecoveryAction[];
  owners: Record<string, string>;
  forecast: { noAction: RecoverySummary; withPlan: RecoverySummary; effect: RecoveryEffect; gapClosed: boolean; risks: TwinRun['risks']; assumptions: string[] };
  options: RecoveryOption[];
  stale: string[];
}

/** "8 months" / "the whole period". */
export function runwayText(months: number | null, horizon: number): string {
  if (months === null) return `Lasts all ${horizon} months`;
  if (months === 0) return 'Runs out this month';
  return `${months} month${months === 1 ? '' : 's'} of cash`;
}
