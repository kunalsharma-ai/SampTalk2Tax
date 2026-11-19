/**
 * What payment reminders achieved (WFLOW-019): for each reminder sent, what the customer paid
 * in the days after it, measured against what was overdue when it was sent. No framework or
 * database code. Money is decimal strings.
 *
 * A receipt counts towards the latest reminder sent to that customer, in the same currency, on
 * or before the receipt's date and no more than the window before it; so a receipt is never
 * counted twice when a customer was reminded more than once. What counts is capped at what was
 * overdue when the reminder went, since a payment beyond it is for other invoices. A receipt dated
 * the day a reminder went counts only if it was recorded after the reminder was sent.
 */
import { addDays, daysBetween } from './documents';
import { D, Dec } from './money';

export interface SentReminder {
  id: string;
  contactId: string;
  customer: string;
  /** The date it was sent, YYYY-MM-DD (organisation's time zone). */
  sentOn: string;
  currency: string;
  /** What the customer owed past due when it was sent. */
  overdueThen: string;
  /** When it was sent (ISO instant): a receipt dated the same day counts only if recorded after it. */
  sentAt?: string;
}

export interface CustomerReceipt {
  contactId: string;
  date: string;
  currency: string;
  amount: string;
  /** When it was recorded (ISO instant). */
  recordedAt?: string;
}

export type ReminderOutcome = 'PAID' | 'PART_PAID' | 'WAITING' | 'NOT_PAID';

export interface ReminderResult {
  id: string;
  contactId: string;
  customer: string;
  sentOn: string;
  currency: string;
  overdueThen: string;
  /** Received from the customer within the window, up to what was overdue then. */
  collected: string;
  /** Days from sending to the first receipt counted, or null. */
  daysToFirstPayment: number | null;
  /** PAID: all of it; PART_PAID: some; WAITING: nothing yet, window still open; NOT_PAID: nothing in the window. */
  outcome: ReminderOutcome;
  /** The last day receipts count for this reminder. */
  windowEnds: string;
}

export interface CurrencySummary {
  currency: string;
  reminders: number;
  overdueThen: string;
  collected: string;
  /** Collected as a share of overdue then, one decimal place, or null when nothing was overdue. */
  collectedShare: string | null;
  paid: number;
  partPaid: number;
  notPaid: number;
  waiting: number;
  /** Average days to the first payment over reminders that were paid in part or in full. */
  averageDaysToPay: number | null;
}

export function reminderResults(reminders: SentReminder[], receipts: CustomerReceipt[], today: string, windowDays = 30): { results: ReminderResult[]; byCurrency: CurrencySummary[] } {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error('The window is a whole number of days, at least 1');
  const sorted = [...reminders].sort((a, b) => a.sentOn.localeCompare(b.sentOn) || a.id.localeCompare(b.id));
  const collected = new Map<string, Dec>();
  const first = new Map<string, string>();
  for (const r of [...receipts].sort((a, b) => a.date.localeCompare(b.date))) {
    // The latest reminder to this customer in this currency sent on or before the receipt, within the window.
    let owner: SentReminder | null = null;
    for (const m of sorted) {
      if (m.contactId !== r.contactId || m.currency !== r.currency || m.sentOn > r.date) continue;
      if (daysBetween(m.sentOn, r.date) > windowDays) continue;
      if (m.sentOn === r.date && m.sentAt && r.recordedAt && r.recordedAt < m.sentAt) continue;
      owner = m;
    }
    if (!owner) continue;
    const so_far = collected.get(owner.id) ?? new D(0);
    const room = new D(owner.overdueThen).minus(so_far);
    if (room.lte(0)) continue;
    const take = D.min(room, new D(r.amount));
    if (take.lte(0)) continue;
    collected.set(owner.id, so_far.plus(take));
    if (!first.has(owner.id)) first.set(owner.id, r.date);
  }
  const results = sorted.map((m): ReminderResult => {
    const got = collected.get(m.id) ?? new D(0);
    const windowEnds = addDays(m.sentOn, windowDays);
    const owed = new D(m.overdueThen);
    const outcome: ReminderOutcome = got.gt(0) && got.gte(owed) ? 'PAID' : got.gt(0) ? 'PART_PAID' : today <= windowEnds ? 'WAITING' : 'NOT_PAID';
    const f = first.get(m.id);
    return { id: m.id, contactId: m.contactId, customer: m.customer, sentOn: m.sentOn, currency: m.currency, overdueThen: owed.toFixed(2), collected: got.toFixed(2), daysToFirstPayment: f ? daysBetween(m.sentOn, f) : null, outcome, windowEnds };
  });
  const currencies = [...new Set(results.map((r) => r.currency))].sort();
  const byCurrency = currencies.map((currency): CurrencySummary => {
    const rs = results.filter((r) => r.currency === currency);
    const owed = rs.reduce((s, r) => s.plus(r.overdueThen), new D(0));
    const got = rs.reduce((s, r) => s.plus(r.collected), new D(0));
    const days = rs.filter((r) => r.daysToFirstPayment !== null).map((r) => r.daysToFirstPayment!);
    return {
      currency,
      reminders: rs.length,
      overdueThen: owed.toFixed(2),
      collected: got.toFixed(2),
      collectedShare: owed.gt(0) ? got.div(owed).times(100).toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed(1) : null,
      paid: rs.filter((r) => r.outcome === 'PAID').length,
      partPaid: rs.filter((r) => r.outcome === 'PART_PAID').length,
      notPaid: rs.filter((r) => r.outcome === 'NOT_PAID').length,
      waiting: rs.filter((r) => r.outcome === 'WAITING').length,
      averageDaysToPay: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
    };
  });
  return { results: results.reverse(), byCurrency };
}
