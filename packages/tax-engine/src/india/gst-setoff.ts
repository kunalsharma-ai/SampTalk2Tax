import { D, Dec } from '@talk2tax/accounting-engine';
import { setOffItc } from './returns';

/**
 * Settling a GST return month from the books (TAX-022): input tax credit set off against the
 * tax payable in the order the CGST Act requires (setOffItc), and the rest paid in cash through
 * the electronic cash ledger (a PMT-06 challan). Cess, and UTGST (treated as SGST), are not
 * separate heads here.
 */

export const GST_HEADS = ['igst', 'cgst', 'sgst'] as const;
export type GstHead = (typeof GST_HEADS)[number];
export type ByHead<T = Dec> = Record<GstHead, T>;

export interface SetOffUse {
  /** The credit used. */
  from: GstHead;
  /** The tax it paid. */
  against: GstHead;
  amount: Dec;
}

export interface GstSetOff {
  liability: ByHead;
  credit: ByHead;
  uses: SetOffUse[];
  /** Credit used per head of credit. */
  creditUsed: ByHead;
  /** Tax paid by credit per head of tax. */
  paidByCredit: ByHead;
  /** Tax left to pay in cash per head, reverse charge included. */
  cash: ByHead;
  /** The reverse-charge tax in the liability, paid in cash only. */
  reverseCharge: ByHead;
  /** Credit carried forward per head. */
  creditLeft: ByHead;
}

const zero = (): ByHead => ({ igst: new D(0), cgst: new D(0), sgst: new D(0) });
const pos = (x: Dec | string) => D.max(new D(x.toString()), 0);

/**
 * Settles a month from the balances in the books: `liability` is what the output tax accounts
 * owe and `credit` what the input tax credit accounts hold. `reverseChargeCash` is the part of
 * the liability that is tax on reverse-charge supplies, which only cash can pay (s.49(4));
 * the rest is set off by setOffItc, and the cash is what is left plus the reverse charge.
 */
export function gstSetOff(liabilityIn: ByHead<Dec | string>, creditIn: ByHead<Dec | string>, reverseChargeCash: ByHead<Dec | string> = { igst: '0', cgst: '0', sgst: '0' }): GstSetOff {
  const liability: ByHead = { igst: pos(liabilityIn.igst), cgst: pos(liabilityIn.cgst), sgst: pos(liabilityIn.sgst) };
  const credit: ByHead = { igst: pos(creditIn.igst), cgst: pos(creditIn.cgst), sgst: pos(creditIn.sgst) };
  const rcm: ByHead = { igst: D.min(pos(reverseChargeCash.igst), liability.igst), cgst: D.min(pos(reverseChargeCash.cgst), liability.cgst), sgst: D.min(pos(reverseChargeCash.sgst), liability.sgst) };
  const s = (x: ByHead) => ({ igst: x.igst.toFixed(), cgst: x.cgst.toFixed(), sgst: x.sgst.toFixed() });
  const r = setOffItc(s({ igst: liability.igst.minus(rcm.igst), cgst: liability.cgst.minus(rcm.cgst), sgst: liability.sgst.minus(rcm.sgst) }), s(credit));
  const uses: SetOffUse[] = [];
  const creditUsed = zero();
  const paidByCredit = zero();
  for (const from of GST_HEADS) {
    for (const against of GST_HEADS) {
      const amount = new D(r.used[from][against]);
      if (amount.isZero()) continue;
      uses.push({ from, against, amount });
      creditUsed[from] = creditUsed[from].plus(amount);
      paidByCredit[against] = paidByCredit[against].plus(amount);
    }
  }
  const cash = { igst: new D(r.cash.igst).plus(rcm.igst), cgst: new D(r.cash.cgst).plus(rcm.cgst), sgst: new D(r.cash.sgst).plus(rcm.sgst) };
  return { liability, credit, uses, creditUsed, paidByCredit, cash, reverseCharge: rcm, creditLeft: { igst: new D(r.carryForward.igst), cgst: new D(r.carryForward.cgst), sgst: new D(r.carryForward.sgst) } };
}

/** The months a GST payment can be for: YYYY-MM, a month that has ended or the current one. */
export function gstPeriodRange(period: string): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error('Give the period as YYYY-MM');
  const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}
