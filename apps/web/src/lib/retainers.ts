export type RetainerState = 'HEALTHY' | 'LOW' | 'EMPTY' | 'CLOSED';

export interface Retainer {
  id: string;
  reference: string;
  contact: { id: string; name: string } | null;
  name: string;
  amount: string;
  minimumBalance: string;
  startDate: string;
  terms: string | null;
  status: 'ACTIVE' | 'CLOSED';
  state: RetainerState;
  held: string;
  topUpDue: string;
  currency: string;
  closedAt: string | null;
  closeReason: string | null;
  createdAt: string;
}

export interface RetainerList {
  retainers: Retainer[];
  totals: { held: string; topUpDue: string; due: number };
  can: { manage: boolean };
}

export interface RetainerDetail extends Retainer {
  receipts: { id: string; number: string; date: string; status: string; amount: string; applied: string; left: string; reference: string | null; bankAccount: { id: string; code: string; name: string } }[];
  drawdowns: { id: string; receipt: string; date: string; amount: string; invoice: { id: string; number: string | null } }[];
  openInvoices: { id: string; number: string; issueDate: string; dueDate: string | null; total: string; open: string }[];
  otherReceipts: { id: string; number: string; date: string; unapplied: string }[];
  can: { manage: boolean };
}

export const RETAINER_STATE: Record<RetainerState, { label: string; tone: 'positive' | 'warning' | 'neutral' | 'negative' }> = {
  HEALTHY: { label: 'Held', tone: 'positive' },
  LOW: { label: 'Top-up due', tone: 'warning' },
  EMPTY: { label: 'Empty', tone: 'negative' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};
