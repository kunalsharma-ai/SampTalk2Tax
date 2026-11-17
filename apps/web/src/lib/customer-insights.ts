import type { RiskRating } from '@talk2tax/accounting-engine';

/** Customer 360 as the API returns it (all money as decimal strings). */
export interface ProfitBlock {
  revenue: string;
  cost: string;
  profit: string;
  /** 0..1 as a decimal string; null without revenue. */
  margin: string | null;
}

export interface CustomerInsight {
  contactId: string;
  name: string;
  isActive: boolean;
  asOf: string;
  currency: string;
  creditLimit: string | null;
  paymentTermsDays: number;
  creditHold: boolean;
  creditHoldReason: string | null;
  creditHoldAt: string | null;
  creditHoldBy: string | null;
  customerSince: string | null;
  invoices: number;
  toDate: ProfitBlock;
  trailing: ProfitBlock;
  months: { month: string; revenue: string; cost: string; profit: string }[];
  projects: { id: string; code: string; name: string; isActive: boolean; cost: string }[];
  contracts: { active: number; paused: number; arr: string; mrr: string; items: { id: string; number: string; title: string; status: string; frequency: string; perPeriod: string; endDate: string | null }[] };
  behaviour: {
    invoices: number;
    paidInvoices: number;
    averageDaysToPay: number | null;
    averageDaysLate: number | null;
    onTimeShare: number | null;
    recentDaysLate: number | null;
    earlierDaysLate: number | null;
    open: string;
    overdue: string;
    oldestOverdueDays: number;
  };
  lifetime: { value: string; earnedToDate: string; annualRevenue: string; annualProfit: string; margin: string; expectedYears: string; assumedYears: boolean; retentionRate: number | null };
  risk: { score: number | null; rating: RiskRating; factors: { key: string; label: string; points: number; max: number; detail: string }[]; suggestedLimit: string | null };
  openInvoices: { id: string; number: string; issueDate: string; dueDate: string; total: string; outstanding: string }[];
  retention: { rate: number | null; customers: number; retained: number };
  can: { manage: boolean };
}

export interface CustomerInsightRow {
  contactId: string;
  name: string;
  revenue: string;
  cost: string;
  profit: string;
  margin: string | null;
  trailingRevenue: string;
  lifetimeValue: string;
  open: string;
  overdue: string;
  averageDaysToPay: number | null;
  risk: { score: number | null; rating: RiskRating };
  creditLimit: string | null;
  creditHold: boolean;
  contractArr: string;
}

export interface CustomerInsightList {
  asOf: string;
  currency: string;
  retention: { rate: number | null; customers: number; retained: number };
  summary: { customers: number; revenue: string; profit: string; lifetimeValue: string; onHold: number; ratings: Record<RiskRating, number> };
  customers: CustomerInsightRow[];
}

export const pctOf = (share: string | number | null | undefined) => (share == null ? '—' : `${(Number(share) * 100).toFixed(1).replace(/\.0$/, '')}%`);
