/**
 * Collections: what a payment reminder for one customer is built from, and the check
 * that a drafted reminder only states figures and invoices taken from the books.
 *
 * An AI model drafts the wording and assesses the risk; everything it is given is worked
 * out here, from posted records, and everything it writes is checked here before a
 * person can send it. No framework or database code. Money is decimal strings.
 */
import { D, Dec } from './money';
import { formatAmountText, formatDateText } from './workflows';

export interface OpenInvoice {
  number: string;
  issueDate: string;
  dueDate: string;
  total: string;
  balance: string;
  reference: string | null;
}

/** An invoice paid in full, with the date the last payment against it was applied. */
export interface PaidInvoice {
  number: string;
  dueDate: string;
  paidOn: string;
}

export interface CustomerFacts {
  customer: string;
  currency: string;
  today: string;
  overdue: (OpenInvoice & { daysOverdue: number })[];
  /** Open invoices not yet due: mentioned for context only. */
  notYetDue: OpenInvoice[];
  totalOverdue: string;
  oldestDaysOverdue: number;
  /** From the last 12 months of invoices paid in full: how late, on average, in days (negative = early); null without history. */
  averageDaysLate: number | null;
  paidInvoicesConsidered: number;
  lastPayment: { date: string; amount: string } | null;
  /** Reminders sent to this customer before, newest first. */
  previousReminders: { sentOn: string; subject: string }[];
}

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round(day(to) - day(from));

/** Builds the facts for one customer's reminder. Overdue means due before today. */
export function customerFacts(p: {
  customer: string;
  currency: string;
  today: string;
  open: OpenInvoice[];
  paid: PaidInvoice[];
  lastPayment: { date: string; amount: string } | null;
  previousReminders: { sentOn: string; subject: string }[];
}): CustomerFacts {
  const overdue = p.open
    .filter((i) => i.dueDate < p.today && new D(i.balance).gt(0))
    .map((i) => ({ ...i, daysOverdue: daysBetween(i.dueDate, p.today) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number));
  const notYetDue = p.open.filter((i) => i.dueDate >= p.today && new D(i.balance).gt(0)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const yearAgo = new Date(Date.parse(`${p.today}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
  const paid = p.paid.filter((x) => x.paidOn >= yearAgo);
  const late = paid.map((x) => daysBetween(x.dueDate, x.paidOn));
  return {
    customer: p.customer,
    currency: p.currency,
    today: p.today,
    overdue,
    notYetDue,
    totalOverdue: overdue.reduce<Dec>((s, i) => s.plus(i.balance), new D(0)).toFixed(2),
    oldestDaysOverdue: overdue.length ? overdue[0].daysOverdue : 0,
    averageDaysLate: late.length ? Math.round(late.reduce((a, b) => a + b, 0) / late.length) : null,
    paidInvoicesConsidered: late.length,
    lastPayment: p.lastPayment,
    previousReminders: p.previousReminders,
  };
}

/** The facts as the model reads them: plain text, amounts written the way the email should write them. */
export function factsForModel(f: CustomerFacts): string {
  const amt = (v: string) => formatAmountText(v, f.currency);
  const lines = [
    `Customer: ${f.customer}`,
    `Today: ${formatDateText(f.today)}`,
    `Overdue invoices (${f.overdue.length}), total still to pay ${amt(f.totalOverdue)}:`,
    ...f.overdue.map((i) => `- ${i.number}${i.reference ? ` (their reference ${i.reference})` : ''}: issued ${formatDateText(i.issueDate)}, due ${formatDateText(i.dueDate)}, ${i.daysOverdue} days overdue, invoice total ${amt(i.total)}, still to pay ${amt(i.balance)}`),
    f.notYetDue.length ? `Invoices not yet due: ${f.notYetDue.map((i) => `${i.number} (${amt(i.balance)}, due ${formatDateText(i.dueDate)})`).join('; ')}` : 'Invoices not yet due: none',
    f.averageDaysLate === null
      ? 'Payment history: no invoices paid in full in the last 12 months.'
      : `Payment history: ${f.paidInvoicesConsidered} invoices paid in full in the last 12 months, on average ${Math.abs(f.averageDaysLate)} days ${f.averageDaysLate >= 0 ? 'after' : 'before'} the due date.`,
    f.lastPayment ? `Last payment received: ${amt(f.lastPayment.amount)} on ${formatDateText(f.lastPayment.date)}.` : 'Last payment received: none on record.',
    f.previousReminders.length ? `Reminders already sent: ${f.previousReminders.map((r) => `${formatDateText(r.sentOn)} ("${r.subject}")`).join('; ')}.` : 'Reminders already sent: none.',
  ];
  return lines.join('\n');
}

export interface DraftCheck {
  ok: boolean;
  label: string;
}

const MONEY_IN_TEXT = /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{4,}\.[0-9]{2})/gi;
const INVOICE_NUMBER = /\bINV-\d{3,}\b/g;

/**
 * Checks a drafted (or edited) reminder against the facts: every amount and every invoice
 * number in it must be one of the customer's, each overdue invoice must be mentioned, and
 * nothing may be empty. A reminder that fails a check cannot be sent until it is fixed.
 */
export function checkDraft(f: CustomerFacts, subject: string, body: string): DraftCheck[] {
  const text = `${subject}\n${body}`;
  const allowedAmounts = new Set<string>();
  const add = (v: string) => allowedAmounts.add(new D(v).toFixed(2));
  for (const i of [...f.overdue, ...f.notYetDue]) {
    add(i.total);
    add(i.balance);
  }
  add(f.totalOverdue);
  if (f.lastPayment) add(f.lastPayment.amount);
  const amounts = [...text.matchAll(MONEY_IN_TEXT)].map((m) => (m[1] ?? m[2]).replace(/,/g, ''));
  const strange = [...new Set(amounts.filter((a) => !allowedAmounts.has(new D(a).toFixed(2))))];
  const known = new Set([...f.overdue, ...f.notYetDue].map((i) => i.number));
  const mentioned = [...new Set(text.match(INVOICE_NUMBER) ?? [])];
  const unknownNumbers = mentioned.filter((n) => !known.has(n));
  const missing = f.overdue.filter((i) => !text.includes(i.number)).map((i) => i.number);
  return [
    { ok: subject.trim().length > 0 && subject.length <= 200 && !/[\r\n]/.test(subject), label: 'A one-line subject of up to 200 characters' },
    { ok: body.trim().length > 0 && body.length <= 5000, label: 'A message of up to 5,000 characters' },
    { ok: strange.length === 0, label: strange.length ? `Amounts not in the books: ${strange.map((a) => formatAmountText(new D(a).toFixed(2), f.currency)).join(', ')}` : 'Every amount matches the books' },
    { ok: unknownNumbers.length === 0, label: unknownNumbers.length ? `Invoice numbers that are not this customer's: ${unknownNumbers.join(', ')}` : "Every invoice number is this customer's" },
    { ok: missing.length === 0, label: missing.length ? `Overdue invoices not mentioned: ${missing.join(', ')}` : 'Every overdue invoice is mentioned' },
  ];
}

export const draftPasses = (checks: DraftCheck[]) => checks.every((c) => c.ok);
