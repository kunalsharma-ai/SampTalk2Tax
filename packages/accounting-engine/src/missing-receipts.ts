import { type Dec, dec } from './money';

/**
 * Missing receipt detection (EXP-021). Claims that went in (submitted, approved or reimbursed)
 * with receipt lines but no receipt attached, and why each one matters:
 * - POLICY: a line is over the expense policy's "receipt above" amount;
 * - CATEGORY: a line is in a category that always needs a receipt;
 * - NONE: no rule asks for one, but nothing backs the spending.
 * Mileage and per diem lines are worked out from rates and need no receipt.
 * Bank spending without a receipt is found separately (receipt matching, EXP-019).
 */
export const MISSING_RECEIPT_REASONS = ['POLICY', 'CATEGORY', 'NONE'] as const;
export type MissingReceiptReason = (typeof MISSING_RECEIPT_REASONS)[number];
export const MISSING_RECEIPT_REASON_LABEL: Record<MissingReceiptReason, string> = { POLICY: 'Required by policy', CATEGORY: 'Category needs one', NONE: 'No receipt' };

export interface MissingReceiptLine {
  lineNo: number;
  amount: string;
  isAllowance: boolean;
  /** Whether its category always needs a receipt. */
  categoryNeedsReceipt: boolean;
}

export interface MissingReceiptClaimInput {
  id: string;
  number: string;
  title: string;
  claimantId: string;
  status: string;
  /** YYYY-MM-DD. */
  submittedOn: string;
  receiptCount: number;
  lines: MissingReceiptLine[];
}

export interface MissingReceiptClaim {
  id: string;
  number: string;
  title: string;
  claimantId: string;
  status: string;
  submittedOn: string;
  daysWaiting: number;
  /** The receipt lines, which a receipt should back. */
  lineNos: number[];
  amount: string;
  reasons: MissingReceiptReason[];
  /** The strongest reason, for sorting and the badge. */
  reason: MissingReceiptReason;
}

const LIVE = new Set(['SUBMITTED', 'APPROVED', 'REIMBURSED']);
const RANK: Record<MissingReceiptReason, number> = { POLICY: 0, CATEGORY: 1, NONE: 2 };

function days(from: string, to: string) {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)); // not money
}

/**
 * The claims missing a receipt, required ones first, then oldest first. `receiptAbove` is the
 * lowest active "receipt above" amount in the policy, or null when there is none.
 */
export function missingClaimReceipts(claims: readonly MissingReceiptClaimInput[], opts: { receiptAbove: string | null; today: string; scale: number }) {
  const above = opts.receiptAbove == null ? null : dec(opts.receiptAbove);
  const items: MissingReceiptClaim[] = [];
  let checked = 0;
  for (const c of claims) {
    if (!LIVE.has(c.status)) continue;
    const receiptLines = c.lines.filter((l) => !l.isAllowance);
    if (!receiptLines.length) continue;
    checked += 1; // not money: a count
    if (c.receiptCount > 0) continue;
    const reasons = new Set<MissingReceiptReason>();
    if (above && receiptLines.some((l) => dec(l.amount).gt(above))) reasons.add('POLICY');
    if (receiptLines.some((l) => l.categoryNeedsReceipt)) reasons.add('CATEGORY');
    if (!reasons.size) reasons.add('NONE');
    const list = [...reasons].sort((a, b) => RANK[a] - RANK[b]);
    items.push({
      id: c.id,
      number: c.number,
      title: c.title,
      claimantId: c.claimantId,
      status: c.status,
      submittedOn: c.submittedOn,
      daysWaiting: days(c.submittedOn, opts.today),
      lineNos: receiptLines.map((l) => l.lineNo),
      amount: receiptLines.reduce<Dec>((s, l) => s.plus(l.amount), dec('0')).toFixed(opts.scale),
      reasons: list,
      reason: list[0],
    });
  }
  items.sort((a, b) => RANK[a.reason] - RANK[b.reason] || a.submittedOn.localeCompare(b.submittedOn) || a.number.localeCompare(b.number));
  const total = (xs: MissingReceiptClaim[]) => xs.reduce<Dec>((s, x) => s.plus(x.amount), dec('0')).toFixed(opts.scale);
  const required = items.filter((x) => x.reason !== 'NONE');
  // Per claimant, most money without receipts first.
  const people = new Map<string, MissingReceiptClaim[]>();
  for (const x of items) people.set(x.claimantId, [...(people.get(x.claimantId) ?? []), x]);
  const byClaimant = [...people]
    .map(([claimantId, xs]) => ({ claimantId, claims: xs.length, amount: total(xs), required: xs.filter((x) => x.reason !== 'NONE').length }))
    .sort((a, b) => dec(b.amount).cmp(a.amount) || a.claimantId.localeCompare(b.claimantId));
  return {
    checked,
    missing: items.length,
    required: required.length,
    amount: total(items),
    requiredAmount: total(required),
    items,
    byClaimant,
  };
}
