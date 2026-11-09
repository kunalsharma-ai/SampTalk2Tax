/**
 * Retainer billing (AR-015).
 *
 * A retainer is money a customer pays in advance and keeps on account with you, at an agreed level.
 * It is held as ordinary receipts that are not yet applied (so the receivables ledger shows the
 * customer in credit), linked to the retainer. Invoices are paid by drawing it down: the retainer's
 * receipts are applied to them, oldest receipt first. When the balance falls below the agreed
 * minimum, the customer is asked to top it up to the agreed level.
 */
import { D, Dec } from './money';

export type RetainerStatus = 'ACTIVE' | 'CLOSED';
export type RetainerState = 'HEALTHY' | 'LOW' | 'EMPTY' | 'CLOSED';

export const RETAINER_STATE_LABEL: Record<RetainerState, string> = {
  HEALTHY: 'Held',
  LOW: 'Top-up due',
  EMPTY: 'Empty',
  CLOSED: 'Closed',
};

export const retainerRef = (n: number) => `RT-${String(n).padStart(4, '0')}`;

const dec = (s: string | Dec) => new D(s.toString());

/** Where a retainer stands from its agreed level, minimum and what is held. */
export function retainerState(r: { status: RetainerStatus; minimumBalance: string }, held: string): RetainerState {
  if (r.status === 'CLOSED') return 'CLOSED';
  if (dec(held).lte(0)) return 'EMPTY';
  return dec(held).lt(r.minimumBalance) ? 'LOW' : 'HEALTHY';
}

/** What the customer should pay to bring the retainer back to its agreed level (0 when not due). */
export function topUpDue(r: { status: RetainerStatus; amount: string; minimumBalance: string }, held: string): string {
  if (r.status === 'CLOSED' || dec(held).gte(r.minimumBalance)) return '0';
  const due = dec(r.amount).minus(held);
  return (due.gt(0) ? due : new D(0)).toFixed();
}

/** Problems with a retainer's terms, as sentences. */
export function retainerIssues(t: { name: string; amount: string; minimumBalance: string }, scale = 2): string[] {
  const issues: string[] = [];
  if (!t.name.trim()) issues.push('Give the retainer a name');
  const a = dec(t.amount || '0');
  const m = dec(t.minimumBalance || '0');
  if (a.lte(0)) issues.push('The agreed amount must be above zero');
  if (m.lt(0)) issues.push('The minimum balance cannot be negative');
  if (m.gt(a)) issues.push('The minimum balance cannot be more than the agreed amount');
  if (a.decimalPlaces() > scale || m.decimalPlaces() > scale) issues.push(`Use at most ${scale} decimal places`);
  return issues;
}

export interface HeldReceipt {
  id: string;
  date: string;
  /** Not yet applied, in the receipt's currency (the functional currency for retainers). */
  unallocated: string;
}
export interface DrawdownInvoice {
  id: string;
  dueDate: string;
  issueDate: string;
  /** Still owed. */
  open: string;
}

/**
 * How to draw down the retainer onto invoices: each invoice (in the order given, or oldest due
 * first when `oldestFirst`) takes up to `amount` (or its open amount), from the oldest receipts
 * first. Returns one allocation per receipt and invoice.
 */
export function planDrawdown(
  receipts: HeldReceipt[],
  invoices: (DrawdownInvoice & { amount?: string | null })[],
  oldestFirst = false,
): { paymentId: string; documentId: string; amount: string }[] {
  // Stable: receipts of the same date keep the order given (the order they were recorded).
  const pool = [...receipts].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({ id: r.id, left: dec(r.unallocated) }));
  const targets = oldestFirst ? [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate)) : invoices;
  const out: { paymentId: string; documentId: string; amount: string }[] = [];
  for (const inv of targets) {
    let want = dec(inv.amount ?? inv.open);
    if (want.gt(inv.open)) want = dec(inv.open);
    for (const r of pool) {
      if (want.lte(0)) break;
      if (r.left.lte(0)) continue;
      const take = D.min(want, r.left);
      r.left = r.left.minus(take);
      want = want.minus(take);
      out.push({ paymentId: r.id, documentId: inv.id, amount: take.toFixed() });
    }
  }
  return out;
}

/** Problems with a drawdown request, as sentences. */
export function drawdownIssues(held: string, invoices: { number: string | null; open: string; amount: string }[]): string[] {
  const issues: string[] = [];
  if (!invoices.length) issues.push('Choose at least one invoice to pay from the retainer');
  let total = new D(0);
  for (const i of invoices) {
    const a = dec(i.amount);
    const name = i.number ?? 'An invoice';
    if (a.lte(0)) issues.push(`${name}: the amount must be above zero`);
    if (a.gt(i.open)) issues.push(`${name}: only ${dec(i.open).toFixed()} is still owed`);
    total = total.plus(a);
  }
  if (total.gt(held)) issues.push(`The retainer holds ${dec(held).toFixed()}; it cannot pay ${total.toFixed()}`);
  return issues;
}
