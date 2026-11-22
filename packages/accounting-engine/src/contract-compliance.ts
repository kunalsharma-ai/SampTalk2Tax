/**
 * Vendor contract compliance (AP-032): posted bills checked against the vendor's contract, with
 * what each finding was raised on. Contract prices are in the functional currency; bill prices
 * are converted at the bill's own exchange rate.
 *
 * - PRICE_ABOVE (high): a line's unit price above the contract price for the same item (HSN/SAC
 *   code, else tidied description: see negotiationItemKey). Amount: the excess times the quantity.
 * - OVER_CAP (high): the bill that takes the spend under the contract above its cap, and every
 *   bill after it. Amount: what the bill adds above the cap.
 * - SHORT_TERMS (medium): the bill is due sooner than the contract's payment terms.
 * - NOT_IN_CONTRACT (low): with "contract items only", a line for an item not on the price list.
 * - OUTSIDE_TERM (medium): a bill dated after the contract ended (or was terminated) when no other
 *   contract of the vendor covers it (worked out by the caller with contractFor).
 * Bills dated before a contract starts are not its business.
 */
import { daysBetween } from './documents';
import { D, type Dec, dec, LEDGER_SCALE, minorUnits, roundToCurrency, sum } from './money';
import { negotiationItemKey } from './supplier-negotiation';

export const CONTRACT_ISSUES = ['PRICE_ABOVE', 'OVER_CAP', 'OUTSIDE_TERM', 'SHORT_TERMS', 'NOT_IN_CONTRACT'] as const;
export type ContractIssueCode = (typeof CONTRACT_ISSUES)[number];
export type ContractIssueSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export const CONTRACT_ISSUE_SEVERITY: Record<ContractIssueCode, ContractIssueSeverity> = { PRICE_ABOVE: 'HIGH', OVER_CAP: 'HIGH', OUTSIDE_TERM: 'MEDIUM', SHORT_TERMS: 'MEDIUM', NOT_IN_CONTRACT: 'LOW' };
export const CONTRACT_ISSUE_LABEL: Record<ContractIssueCode, string> = {
  PRICE_ABOVE: 'Price above contract',
  OVER_CAP: 'Over the spend cap',
  OUTSIDE_TERM: 'Outside the contract term',
  SHORT_TERMS: 'Shorter payment terms',
  NOT_IN_CONTRACT: 'Item not in the contract',
};

export interface ContractTerms {
  startDate: string;
  /** The last day covered: the end date, or the day of termination if earlier. */
  endDate: string;
  paymentTermsDays: number | null;
  spendCap: string | null;
  itemsOnly: boolean;
  prices: { key: string; label: string; unitPrice: string }[];
}

export interface ComplianceBill {
  id: string;
  number: string;
  issueDate: string;
  dueDate: string;
  exchangeRate: string;
  subtotal: string;
  lines: { description: string | null; hsnCode: string | null; quantity: string; unitPrice: string }[];
}

export interface ContractIssue {
  billId: string;
  billNumber: string;
  date: string;
  code: ContractIssueCode;
  severity: ContractIssueSeverity;
  detail: string;
  amount: string | null;
}

/** The contract that covers a date: started on or before it and not ended before it. */
export function contractFor<T extends { startDate: string; endDate: string }>(contracts: readonly T[], date: string): T | null {
  return contracts.find((c) => c.startDate <= date && date <= c.endDate) ?? null;
}

/** A price list entry's key, from the HSN/SAC code or the description typed in. */
export function contractPriceKey(entry: { hsnCode?: string | null; description?: string | null }): string | null {
  return negotiationItemKey({ hsnCode: entry.hsnCode ?? null, description: entry.description ?? null });
}

export function checkContractCompliance(terms: ContractTerms, bills: readonly ComplianceBill[], currency: string) {
  const m = minorUnits(currency);
  const show = (v: Dec) => roundToCurrency(v, currency).toFixed(m);
  const prices = new Map(terms.prices.map((p) => [p.key, p]));
  const covered = [...bills].filter((b) => b.issueDate >= terms.startDate && b.issueDate <= terms.endDate).sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  const issues: ContractIssue[] = [];
  const cap = terms.spendCap ? dec(terms.spendCap) : null;
  let spend = new D(0);
  for (const b of covered) {
    const issue = (code: ContractIssueCode, detail: string, amount: Dec | null = null) => issues.push({ billId: b.id, billNumber: b.number, date: b.issueDate, code, severity: CONTRACT_ISSUE_SEVERITY[code], detail, amount: amount ? show(amount) : null });
    for (const l of b.lines) {
      const key = negotiationItemKey(l);
      const qty = dec(l.quantity);
      const price = dec(l.unitPrice).times(dec(b.exchangeRate)).toDecimalPlaces(LEDGER_SCALE);
      const agreed = key ? prices.get(key) : undefined;
      const label = l.description?.trim() || l.hsnCode?.trim() || 'A line with no description';
      if (agreed && price.gt(dec(agreed.unitPrice))) {
        issue('PRICE_ABOVE', `${label}: billed ${show(price)} a unit, the contract price is ${show(dec(agreed.unitPrice))} (${qty.toFixed()} units)`, price.minus(dec(agreed.unitPrice)).times(qty));
      } else if (!agreed && terms.itemsOnly) {
        issue('NOT_IN_CONTRACT', `${label} is not on the contract's price list`);
      }
    }
    if (terms.paymentTermsDays !== null) {
      const days = daysBetween(b.issueDate, b.dueDate); // not money
      if (days < terms.paymentTermsDays) issue('SHORT_TERMS', `Due ${days} days after the bill date; the contract gives ${terms.paymentTermsDays} days`);
    }
    const amount = roundToCurrency(dec(b.subtotal).times(dec(b.exchangeRate)), currency);
    const before = spend;
    spend = spend.plus(amount);
    if (cap && spend.gt(cap)) issue('OVER_CAP', `Spend under the contract reaches ${show(spend)}, above the cap of ${show(cap)}`, spend.minus(D.max(before, cap)));
  }
  const overcharge = sum(issues.filter((i) => i.code === 'PRICE_ABOVE').map((i) => dec(i.amount!)));
  return {
    spend: show(spend),
    capUsed: cap && cap.gt(0) ? spend.times(100).div(cap).toDecimalPlaces(1).toFixed(1) : null,
    billsChecked: covered.length,
    billsWithIssues: new Set(issues.map((i) => i.billId)).size,
    overcharge: show(overcharge),
    issues,
  };
}

/** A bill after the vendor's contracts ended, with nothing covering it. */
export function outsideTermIssue(bill: Pick<ComplianceBill, 'id' | 'number' | 'issueDate'>, contract: { endDate: string; reference: string }): ContractIssue {
  return { billId: bill.id, billNumber: bill.number, date: bill.issueDate, code: 'OUTSIDE_TERM', severity: 'MEDIUM', detail: `Billed on ${bill.issueDate}, after contract ${contract.reference} ended on ${contract.endDate}`, amount: null };
}
