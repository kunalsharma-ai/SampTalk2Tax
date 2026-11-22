/**
 * Receipt-to-transaction matching (EXP-019): receipts people upload for spending paid from a
 * company bank or card account, matched to the money-out lines of imported bank statements.
 * Deterministic and explainable: every suggestion says why, no model is used, and amounts are
 * decimal strings. Nothing is matched here; a person confirms each match.
 *
 * Score (out of 100), for a receipt and a money-out line in the same currency, at most 10 days apart:
 * - amount: the same as the receipt 50; within 2% of it (bank charges, a tip, card fees) 25;
 *   otherwise not a candidate.
 * - date: the same day 30; 1 to 3 days apart 20; 4 to 7 days 10; 8 to 10 days 0.
 * - name: a word of the merchant's name in the bank narration or reference 20.
 * 90 or more is HIGH, 70 or more MEDIUM, 50 or more LOW; below 50 is not suggested. Each receipt
 * gets at most one line and each line at most one receipt, best scores first; a receipt that
 * another line fits just as well is never HIGH.
 */
import { daysBetween } from './documents';
import { D } from './money';

export type ReceiptMatchConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export const RECEIPT_MATCH_CONFIDENCE_LABEL: Record<ReceiptMatchConfidence, string> = { HIGH: 'Sure', MEDIUM: 'Likely', LOW: 'Possible' };
export const RECEIPT_MATCH_MAX_DAYS = 10;

export interface ReceiptFact {
  id: string;
  date: string;
  /** What the receipt says was paid, positive. */
  amount: string;
  currency: string;
  merchant: string;
}

export interface SpendLine {
  id: string;
  date: string;
  /** The statement amount: money out is negative. */
  amount: string;
  currency: string;
  description: string;
  reference?: string | null;
}

export interface ReceiptMatchScore {
  score: number;
  confidence: ReceiptMatchConfidence;
  reasons: string[];
}

export interface ReceiptMatchSuggestion extends ReceiptMatchScore {
  receiptId: string;
  lineId: string;
  /** Other lines that fit this receipt with a score of 50 or more. */
  alternatives: number;
}

/** Bank narration words that say nothing about who was paid. */
const NOISE = new Set(['pos', 'upi', 'neft', 'imps', 'rtgs', 'ach', 'nach', 'ecs', 'card', 'debit', 'credit', 'txn', 'ref', 'refno', 'payment', 'paid', 'purchase', 'online', 'india', 'pvt', 'ltd', 'private', 'limited', 'llp', 'the', 'and', 'store', 'stores', 'shop', 'services', 'service', 'bank', 'transfer', 'trf', 'mmt', 'atm', 'www', 'com']);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w));
const confidenceOf = (score: number): ReceiptMatchConfidence | null => (score >= 90 ? 'HIGH' : score >= 70 ? 'MEDIUM' : score >= 50 ? 'LOW' : null); // not money
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** How well one money-out line fits one receipt; null when it cannot be the receipt's payment. */
export function scoreReceiptMatch(r: ReceiptFact, l: SpendLine): ReceiptMatchScore | null {
  if (r.currency !== l.currency) return null;
  const paid = new D(l.amount);
  if (!paid.isNegative()) return null;
  const out = paid.abs();
  const want = new D(r.amount);
  if (want.lte(0)) return null;
  const gap = Math.abs(daysBetween(r.date, l.date)); // not money
  if (gap > RECEIPT_MATCH_MAX_DAYS) return null;
  const reasons: string[] = [];
  let score = 0; // not money
  const diff = out.minus(want);
  if (diff.isZero()) {
    score += 50; // not money
    reasons.push('Same amount');
  } else if (diff.abs().lte(want.times('0.02'))) {
    score += 25; // not money
    reasons.push(`Paid ${diff.isPositive() ? 'more' : 'less'} by ${diff.abs().toFixed(2)} (charges or a tip?)`);
  } else return null;
  if (gap === 0) {
    score += 30; // not money
    reasons.push('Same day');
  } else {
    score += gap <= 3 ? 20 : gap <= 7 ? 10 : 0; // not money
    reasons.push(`${gap} day${gap === 1 ? '' : 's'} apart (receipt ${fmt(r.date)}, bank ${fmt(l.date)})`);
  }
  const narration = new Set(words(`${l.description} ${l.reference ?? ''}`));
  const hit = words(r.merchant).find((w) => narration.has(w));
  if (hit) {
    score += 20; // not money
    reasons.push(`"${hit.toUpperCase()}" in the bank narration`);
  } else reasons.push('Merchant name not in the bank narration');
  const confidence = confidenceOf(score);
  return confidence ? { score, confidence, reasons } : null;
}

/** One line for each receipt (and one receipt for each line), best scores first. */
export function suggestReceiptMatches(receipts: readonly ReceiptFact[], lines: readonly SpendLine[]): ReceiptMatchSuggestion[] {
  const pairs: { r: ReceiptFact; l: SpendLine; s: ReceiptMatchScore; gap: number }[] = [];
  for (const r of receipts) for (const l of lines) {
    const s = scoreReceiptMatch(r, l);
    if (s) pairs.push({ r, l, s, gap: Math.abs(daysBetween(r.date, l.date)) }); // not money
  }
  pairs.sort((a, b) => b.s.score - a.s.score || a.gap - b.gap || a.r.date.localeCompare(b.r.date) || a.r.id.localeCompare(b.r.id) || a.l.id.localeCompare(b.l.id)); // not money
  const usedR = new Set<string>();
  const usedL = new Set<string>();
  const out: ReceiptMatchSuggestion[] = [];
  for (const p of pairs) {
    if (usedR.has(p.r.id) || usedL.has(p.l.id)) continue;
    usedR.add(p.r.id);
    usedL.add(p.l.id);
    const mine = pairs.filter((q) => q.r.id === p.r.id && q.l.id !== p.l.id);
    const tie = mine.some((q) => q.s.score === p.s.score);
    const s = tie ? { ...p.s, confidence: p.s.confidence === 'HIGH' ? ('MEDIUM' as const) : p.s.confidence, reasons: [...p.s.reasons, 'Another bank line fits as well: check which one'] } : p.s;
    out.push({ receiptId: p.r.id, lineId: p.l.id, alternatives: mine.length, ...s });
  }
  return out;
}
