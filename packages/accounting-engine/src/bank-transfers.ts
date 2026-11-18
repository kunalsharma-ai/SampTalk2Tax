import type { Dec } from './money';

/**
 * Transfers between the organisation's own bank and cash accounts (Directive Part 8, BANK-007).
 * Money leaving one account and the same amount arriving in another within a few days is most
 * likely a transfer, not income or an expense. Both statement lines are then recorded with one
 * entry (Dr receiving account / Cr paying account) instead of being booked as two unrelated items.
 */

export const TRANSFER_WINDOW_DAYS = 3;
const TRANSFER_WORDS = /\b(transfer|trf|tfr|xfer|self|own account|sweep|fund transfer|neft|imps|rtgs|upi)\b/i;

export interface TransferLine {
  id: string;
  accountId: string;
  date: string;
  /** Positive = money in, negative = out. */
  amount: Dec;
  text: string;
}

export interface TransferAccount {
  id: string;
  code: string;
  name: string;
}

export interface TransferSuggestion {
  outLineId: string;
  inLineId: string;
  fromAccountId: string;
  toAccountId: string;
  days: number;
  score: number;
  reasons: string[];
  /** True when neither line has another candidate: safe to record without a second look. */
  unique: boolean;
}

function days(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** Mentions the other account by name or by its code (whole words), such as "to HDFC current" or "1130". */
function mentions(text: string, a: TransferAccount | undefined): boolean {
  if (!a) return false;
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (t.includes(` ${a.code.toLowerCase()} `)) return true;
  const words = a.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !['bank', 'account', 'current', 'savings', 'cash'].includes(w));
  return words.length > 0 && words.some((w) => t.includes(` ${w} `));
}

/**
 * Pairs of unmatched statement lines that look like one transfer: money out of one account and
 * the same amount into another, at most TRANSFER_WINDOW_DAYS apart. Each line is in at most one
 * pair; better pairs (closer dates, transfer wording, the other account named) win.
 */
export function suggestTransfers(lines: readonly TransferLine[], accounts: readonly TransferAccount[], windowDays = TRANSFER_WINDOW_DAYS): TransferSuggestion[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const outs = lines.filter((l) => l.amount.lt(0));
  const ins = lines.filter((l) => l.amount.gt(0));
  const candidates: TransferSuggestion[] = [];
  for (const o of outs) {
    for (const i of ins) {
      if (i.accountId === o.accountId || !i.amount.eq(o.amount.neg())) continue;
      const gap = days(o.date, i.date);
      if (gap > windowDays) continue;
      const reasons = ['Same amount out and in', gap === 0 ? 'Same day' : `${gap} day${gap === 1 ? '' : 's'} apart`];
      let score = 60 - gap * 10;
      if (TRANSFER_WORDS.test(o.text) || TRANSFER_WORDS.test(i.text)) {
        score += 15;
        reasons.push('Described as a transfer');
      }
      if (mentions(o.text, byId.get(i.accountId)) || mentions(i.text, byId.get(o.accountId))) {
        score += 25;
        reasons.push('Names the other account');
      }
      candidates.push({ outLineId: o.id, inLineId: i.id, fromAccountId: o.accountId, toAccountId: i.accountId, days: gap, score, reasons, unique: false });
    }
  }
  const count = new Map<string, number>();
  for (const c of candidates) for (const k of [c.outLineId, c.inLineId]) count.set(k, (count.get(k) ?? 0) + 1);
  candidates.sort((a, b) => b.score - a.score || a.days - b.days || a.outLineId.localeCompare(b.outLineId) || a.inLineId.localeCompare(b.inLineId));
  const used = new Set<string>();
  const out: TransferSuggestion[] = [];
  for (const c of candidates) {
    if (used.has(c.outLineId) || used.has(c.inLineId)) continue;
    used.add(c.outLineId);
    used.add(c.inLineId);
    out.push({ ...c, unique: count.get(c.outLineId) === 1 && count.get(c.inLineId) === 1 });
  }
  return out;
}
