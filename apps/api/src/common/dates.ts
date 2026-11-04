import { assertIsoDate } from '@talk2tax/accounting-engine';

export function toDbDate(iso: string): Date {
  assertIsoDate(iso);
  return new Date(`${iso}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Today's date in India (YYYY-MM-DD). The whole product keeps one business calendar, India time,
 * so "today" (future-date checks, due and overdue, defaults) agrees between every module and the
 * web app, also between 00:00 and 05:30 IST when the UTC date is still yesterday.
 */
export function todayIso(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** The date in India (YYYY-MM-DD) of a moment, e.g. when a reminder was sent. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}
