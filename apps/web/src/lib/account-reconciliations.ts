import { today } from '@/lib/format';

/** Balance sheet account reconciliations (GL-032, GL-023). */

export type ReconState = 'NOT_STARTED' | 'DRAFT' | 'PREPARED' | 'REVIEWED' | 'CHANGED';
export type ReconItemKind = 'SUPPORT' | 'RECONCILING';

export interface ReconRow {
  accountId: string;
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY';
  isBank: boolean;
  ledgerBalance: string;
  subledgerBalance: string | null;
  subledgerDifference: string | null;
  state: ReconState;
  difference: string | null;
  preparedBy: string | null;
  reviewedBy: string | null;
}

export interface ReconList {
  asOf: string;
  currency: string;
  accounts: ReconRow[];
  counts: Record<ReconState, number>;
}

export interface ReconItem {
  id?: string;
  description: string;
  reference: string | null;
  amount: string;
  kind: ReconItemKind;
}

export interface ReconDetail {
  accountId: string;
  code: string;
  name: string;
  type: string;
  isBank: boolean;
  asOf: string;
  currency: string;
  ledgerBalance: string;
  savedLedgerBalance: string | null;
  subledgerBalance: string | null;
  state: ReconState;
  id: string | null;
  status: 'DRAFT' | 'PREPARED' | 'REVIEWED' | null;
  notes: string | null;
  items: ReconItem[];
  supported: string;
  reconciling: string;
  explained: string;
  difference: string;
  balanced: boolean;
  suggestions: ReconItem[];
  preparedBy: string | null;
  preparedById: string | null;
  preparedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  history: { id: string; kind: 'SAVED' | 'PREPARED' | 'REVIEWED' | 'REOPENED'; note: string | null; by: string | null; at: string }[];
}

export const STATE_LABEL: Record<ReconState, string> = {
  NOT_STARTED: 'Not started',
  DRAFT: 'In progress',
  PREPARED: 'Waiting for review',
  REVIEWED: 'Reviewed',
  CHANGED: 'Changed since sign-off',
};

export const STATE_TONE: Record<ReconState, 'neutral' | 'accent' | 'positive' | 'warning' | 'negative'> = {
  NOT_STARTED: 'neutral',
  DRAFT: 'accent',
  PREPARED: 'warning',
  REVIEWED: 'positive',
  CHANGED: 'negative',
};

export const KIND_LABEL: Record<ReconItemKind, string> = { SUPPORT: 'Supporting balance', RECONCILING: 'Reconciling item' };

export const EVENT_LABEL = { SAVED: 'Saved', PREPARED: 'Prepared', REVIEWED: 'Reviewed', REOPENED: 'Reopened' } as const;

/** The last day of the month before today: the usual date to reconcile to. */
export function lastMonthEnd(from = today()): string {
  const d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}
