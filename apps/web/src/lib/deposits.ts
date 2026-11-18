import type { DepositCompounding } from '@talk2tax/accounting-engine';

export type { DepositCompounding };
export type Choice = { id: string; code: string; name: string };

export interface DepositSummary {
  id: string;
  number: string;
  name: string;
  institution: string;
  institutionRef: string | null;
  principal: string;
  annualRate: string;
  compounding: DepositCompounding;
  startDate: string;
  maturityDate: string;
  status: 'OPEN' | 'CLOSED';
  accrued: string;
  accruedTo: string | null;
  earnedToDate: string;
  notAccrued: string;
  maturityInterest: string;
  maturityValue: string;
  daysToMaturity: number;
}

export interface DepositList {
  items: DepositSummary[];
  totals: { principal: string; accrued: string; earnedToDate: string; atMaturity: string };
  maturingIn30Days: number;
  can: { manage: boolean };
}

export interface DepositEvent {
  id: string;
  kind: 'PLACED' | 'ACCRUED' | 'CLOSED';
  date: string;
  amount: string;
  received: string | null;
  tds: string | null;
  interest: string | null;
  incomeNow: string | null;
  early: boolean;
  entryId: string;
  reversed: boolean;
  reversalEntryId: string | null;
  note: string | null;
  by: string | null;
  canReverse: boolean;
}

export interface DepositDetail extends DepositSummary {
  can: { manage: boolean };
  accounts: { bank: Choice; deposit: Choice; accruedInterest: Choice; interestIncome: Choice };
  events: DepositEvent[];
}

export interface DepositAccounts {
  bank: Choice[];
  deposit: Choice[];
  accruedInterest: Choice[];
  interestIncome: Choice[];
  tds: Choice[];
}

export const COMPOUNDING: Record<DepositCompounding, string> = {
  QUARTERLY: 'Quarterly',
  MONTHLY: 'Monthly',
  HALF_YEARLY: 'Half-yearly',
  YEARLY: 'Yearly',
  SIMPLE: 'Simple interest (no compounding)',
};
