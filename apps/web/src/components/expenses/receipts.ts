import type { ReceiptMatchConfidence } from '@talk2tax/accounting-engine';

export interface ReceiptBankLine {
  id: string;
  account: { id: string; name: string };
  date: string;
  amount: string;
  currency: string;
  description: string;
  reference: string | null;
}

export interface ExpenseReceipt {
  id: string;
  reference: string;
  merchant: string;
  date: string;
  amount: string;
  currency: string;
  note: string | null;
  status: 'UNMATCHED' | 'MATCHED' | 'DISCARDED';
  files: { id: string; fileName: string }[];
  /** Uploaded by the person viewing. */
  mine: boolean;
  uploadedBy: { id: string; name: string };
  uploadedAt: string;
  matchedLine: ReceiptBankLine | null;
  matchedBy: { id: string; name: string } | null;
  matchedAt: string | null;
  suggestion: { line: ReceiptBankLine; score: number; confidence: ReceiptMatchConfidence; reasons: string[]; alternatives: number } | null;
  history: { at: string; by: string; action: string; note: string }[];
}

export interface ReceiptList {
  canMatch: boolean;
  summary: { unmatched: number; matched: number; discarded: number; sure: number };
  items: ExpenseReceipt[];
}

export const RECEIPT_STATUS = {
  UNMATCHED: { label: 'Not matched', tone: 'warning' },
  MATCHED: { label: 'Matched', tone: 'positive' },
  DISCARDED: { label: 'Discarded', tone: 'neutral' },
} as const;
export const CONFIDENCE_TONE = { HIGH: 'positive', MEDIUM: 'accent', LOW: 'neutral' } as const;
