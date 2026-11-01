export const HORIZONS = [30, 60, 90, 180, 365] as const;
export type Horizon = (typeof HORIZONS)[number];
export type Frequency = 'ONCE' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export const FREQUENCY: Record<Frequency, string> = { ONCE: 'Once', WEEKLY: 'Every week', MONTHLY: 'Every month', QUARTERLY: 'Every quarter', YEARLY: 'Every year' };

export interface ForecastDay {
  date: string;
  base: string;
  low: string;
  high: string;
}
export interface ForecastBucket {
  from: string;
  to: string;
  opening: string;
  inflows: { RECEIVABLE: string; PLANNED_IN: string };
  outflows: { PAYABLE: string; PLANNED_OUT: string };
  net: string;
  closing: string;
  low: string;
  high: string;
}
export interface OpenItem {
  id: string;
  contactId: string;
  contactName: string;
  number: string;
  dueDate: string;
  open: string;
  expected: { early: string; base: string; late: string };
  inHorizon: boolean;
  pastTypical: boolean;
  doubtful: boolean;
  basis: { source: 'CONTACT' | 'ALL_CONTACTS' | 'DUE_DATE'; samples: number; medianDelay: number | null };
}
export interface DelaySummary {
  samples: number;
  p25: number | null;
  median: number | null;
  p75: number | null;
}
export interface CashForecast {
  currency: string;
  today: string;
  isBacktest: boolean;
  horizonDays: number;
  minimumBalance: string;
  cashAccounts: { id: string; code: string; name: string; balance: string }[];
  asOf: string;
  start: string;
  end: string;
  opening: string;
  days: ForecastDay[];
  buckets: ForecastBucket[];
  closing: { base: string; low: string; high: string };
  lowest: { base: { date: string; amount: string }; low: { date: string; amount: string } };
  belowBuffer: { base: string | null; low: string | null };
  totals: { RECEIVABLE: string; PAYABLE: string; PLANNED_IN: string; PLANNED_OUT: string };
  receivables: OpenItem[];
  payables: OpenItem[];
  planned: { itemId: string; name: string; direction: 'IN' | 'OUT'; date: string; amount: string }[];
  unapplied: { receipts: string; payments: string };
  delays: { customers: DelaySummary; vendors: DelaySummary };
}
export interface PlannedItem {
  id: string;
  name: string;
  direction: 'IN' | 'OUT';
  amount: string;
  frequency: Frequency;
  startDate: string;
  endDate: string | null;
  note: string | null;
  isActive: boolean;
}
export interface Accuracy {
  days: number;
  meanAbsoluteError: string;
  bias: string;
  withinRange: string;
  largestMiss?: { date: string; forecast: string; actual: string; error: string } | null;
  series?: { date: string; base: string; low: string; high: string; actual: string; error: string }[];
}
export interface SavedSummary {
  id: string;
  asOf: string;
  horizonDays: number;
  isBacktest: boolean;
  opening: string;
  closingBase: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
  accuracy: Accuracy;
}
export interface SavedForecast extends Omit<SavedSummary, 'accuracy'> {
  currency: string;
  minimumBalance: string | null;
  inputs: { closing: { base: string; low: string; high: string }; lowest: CashForecast['lowest']; belowBuffer: CashForecast['belowBuffer']; totals: CashForecast['totals']; receivables: number; payables: number; planned: number };
  days: ForecastDay[];
  accuracy: Required<Accuracy>;
}

export const BASIS: Record<OpenItem['basis']['source'], string> = {
  CONTACT: 'own history',
  ALL_CONTACTS: 'everyone’s history',
  DUE_DATE: 'due date',
};
