import { csvField, neutraliseFormula } from './report-export';
import { D, dec, Dec, minorUnits } from './money';

/**
 * Payment batches (AP-014) and the vendor bank-detail checks that guard them (AP-027).
 *
 * A batch gathers bills to pay from one bank account on one date. It is prepared, approved by a
 * second person, sent to the bank as a payment file, and recorded as paid, which makes one payment
 * per vendor through the normal payment code. Money is moved by the bank, never by the app.
 *
 * Bank details are where payment fraud happens: a "new account" letter from a supplier. Any change
 * to a vendor's bank details must be verified by someone other than the person who made it before
 * a batch paying that vendor can be approved.
 */

export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_PATTERN = /^[0-9A-Z]{6,34}$/;

export interface BankDetailsInput {
  accountName: string;
  accountNumber: string;
  ifsc: string;
  bankName?: string | null;
}

/** Account number without spaces or dashes, upper case. */
export function normaliseAccountNumber(n: string): string {
  return n.replace(/[\s-]/g, '').toUpperCase();
}

/** What is wrong with bank details as entered; empty when they can be saved. */
export function bankDetailIssues(b: BankDetailsInput): string[] {
  const issues: string[] = [];
  if (!b.accountName.trim()) issues.push("Enter the account holder's name as the bank has it");
  if (!ACCOUNT_PATTERN.test(normaliseAccountNumber(b.accountNumber))) issues.push('An account number is 6 to 34 letters or digits');
  if (!IFSC_PATTERN.test(b.ifsc.trim().toUpperCase())) issues.push('An IFSC is 11 characters: four letters, a zero, then six letters or digits (e.g. HDFC0001234)');
  return issues;
}

/** Shows only the last four characters: XXXXXX1234. */
export function maskAccountNumber(n: string): string {
  const s = normaliseAccountNumber(n);
  return s.length <= 4 ? s : `${'X'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

export interface BatchItemCheck {
  documentId: string;
  number: string;
  vendor: string;
  amount: string;
  /** What is still owed on the bill now. */
  due: string;
  billStatus: string;
  bank: { hasDetails: boolean; verified: boolean; international?: boolean } | null;
}

/** Why each item cannot be approved or paid as it stands, by bill number. */
export function batchItemIssues(items: readonly BatchItemCheck[], currency: string): { documentId: string; number: string; issue: string }[] {
  const out: { documentId: string; number: string; issue: string }[] = [];
  const scale = minorUnits(currency);
  for (const i of items) {
    const amount = dec(i.amount);
    if (i.billStatus !== 'POSTED') out.push({ documentId: i.documentId, number: i.number, issue: `${i.number} is no longer posted` });
    else if (amount.gt(dec(i.due))) out.push({ documentId: i.documentId, number: i.number, issue: `${i.number} now has ${dec(i.due).toFixed(scale)} ${currency} left to pay, less than the ${amount.toFixed(scale)} in the batch` });
    if (!i.bank?.hasDetails) out.push({ documentId: i.documentId, number: i.number, issue: `${i.vendor} has no bank details` });
    else if (i.bank.international) out.push({ documentId: i.documentId, number: i.number, issue: `${i.vendor} is paid to a bank abroad; pay them with an international payment` });
    else if (!i.bank.verified) out.push({ documentId: i.documentId, number: i.number, issue: `${i.vendor}'s bank details were changed and are not verified yet` });
  }
  return out;
}

/** One payment per vendor: the items grouped, in the order the vendors first appear. */
export function paymentsByVendor<T extends { contactId: string; amount: string }>(items: readonly T[], currency: string): { contactId: string; amount: string; items: T[] }[] {
  const scale = minorUnits(currency);
  const groups = new Map<string, { total: Dec; items: T[] }>();
  for (const i of items) {
    const g = groups.get(i.contactId) ?? { total: new D(0), items: [] };
    g.total = g.total.plus(dec(i.amount));
    g.items.push(i);
    groups.set(i.contactId, g);
  }
  return [...groups].map(([contactId, g]) => ({ contactId, amount: g.total.toFixed(scale), items: g.items }));
}

export interface PaymentFileRow {
  vendor: string;
  accountName: string;
  accountNumber: string;
  ifsc: string;
  amount: string;
  reference: string;
  email: string | null;
}

/**
 * The bulk payment file for the bank: one row per vendor. A plain CSV with the columns most Indian
 * banks' bulk-upload templates ask for; text that a spreadsheet could read as a formula is
 * neutralised.
 */
export function paymentFileCsv(batch: { reference: string; date: string; debitAccount: string; currency: string }, rows: readonly PaymentFileRow[]): string {
  const t = (s: string) => csvField(neutraliseFormula(s));
  const lines = [['Payment date', 'Debit account', 'Beneficiary name', 'Beneficiary account number', 'IFSC', 'Amount', 'Currency', 'Payment reference', 'Beneficiary email', 'Vendor'].map(t).join(',')];
  for (const r of rows) {
    lines.push([batch.date, batch.debitAccount, r.accountName, r.accountNumber, r.ifsc, r.amount, batch.currency, r.reference.slice(0, 30), r.email ?? '', r.vendor].map((x) => t(String(x))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
