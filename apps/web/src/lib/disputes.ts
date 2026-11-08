import type { DisputeOutcome, DisputeReason } from '@talk2tax/accounting-engine';

export { DISPUTE_OUTCOME_LABEL, DISPUTE_OUTCOMES, DISPUTE_REASON_LABEL, DISPUTE_REASONS } from '@talk2tax/accounting-engine';
export type { DisputeOutcome, DisputeReason };

export interface Dispute {
  id: string;
  ref: string;
  status: 'OPEN' | 'RESOLVED';
  invoice: { id: string; number: string | null; issueDate: string; dueDate: string | null; total: string; due: string; currency: string };
  customer: { id: string; name: string };
  amount: string;
  functionalAmount: string;
  reason: DisputeReason;
  description: string;
  owner: { id: string; name: string } | null;
  targetDate: string | null;
  pastTarget: boolean;
  openedOn: string;
  openedBy: string;
  days: number;
  outcome: DisputeOutcome | null;
  creditNote: { id: string; number: string | null } | null;
  resolutionNote: string | null;
  resolvedOn: string | null;
  resolvedBy: string | null;
}

export interface DisputeEvent {
  id: string;
  kind: 'RAISED' | 'NOTE' | 'CHANGED' | 'RESOLVED';
  body: string | null;
  data: Record<string, unknown> | null;
  by: string;
  at: string;
}

export interface Member {
  id: string;
  name: string;
}

export interface DisputeList {
  today: string;
  currency: string;
  summary: { open: number; openAmount: string; pastTarget: number; oldestOpenDays: number | null; resolved: number; averageDaysToResolve: number | null; outcomes: Record<DisputeOutcome, number> };
  disputes: Dispute[];
  members: Member[];
  can: { manage: boolean };
}

export interface DisputeDetail extends Dispute {
  events: DisputeEvent[];
  creditNotes: { id: string; number: string | null; issueDate: string; total: string; currency: string }[];
  members: Member[];
  can: { manage: boolean };
}

export const CHANGE_LABEL: Record<string, string> = { amount: 'Amount', reason: 'Reason', description: 'Description', owner: 'Owner', targetDate: 'Target date' };
