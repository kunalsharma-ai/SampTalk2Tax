import type { ContractIssueCode, ContractIssueSeverity } from '@talk2tax/accounting-engine';

export type ContractState = 'NOT_STARTED' | 'IN_FORCE' | 'ENDED' | 'TERMINATED';
export interface ContractIssueView {
  billId: string;
  billNumber: string;
  date: string;
  code: ContractIssueCode;
  label: string;
  severity: ContractIssueSeverity;
  detail: string;
  amount: string | null;
}
export interface VendorContract {
  id: string;
  reference: string;
  title: string;
  vendor: { id: string; name: string };
  vendorReference: string | null;
  startDate: string;
  endDate: string;
  currency: string;
  paymentTermsDays: number | null;
  spendCap: string | null;
  itemsOnly: boolean;
  status: 'ACTIVE' | 'TERMINATED';
  state: ContractState;
  terminatedOn: string | null;
  spend: string;
  capUsed: string | null;
  billsChecked: number;
  billsWithIssues: number;
  overcharge: string;
}

export const STATE_LABEL: Record<ContractState, string> = { NOT_STARTED: 'Not started', IN_FORCE: 'In force', ENDED: 'Ended', TERMINATED: 'Terminated' };
export const STATE_TONE: Record<ContractState, 'neutral' | 'positive' | 'warning'> = { NOT_STARTED: 'neutral', IN_FORCE: 'positive', ENDED: 'neutral', TERMINATED: 'warning' };
export const SEVERITY_TONE: Record<ContractIssueSeverity, 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };
export const SEVERITY_LABEL: Record<ContractIssueSeverity, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };
