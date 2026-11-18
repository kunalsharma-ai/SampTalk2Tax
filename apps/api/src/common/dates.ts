import { assertIsoDate, calendarDate } from '@talk2tax/accounting-engine';
import { currentTimeZone } from './tenant-context';

export function toDbDate(iso: string): Date {
  assertIsoDate(iso);
  return new Date(`${iso}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Today's business date (YYYY-MM-DD) for the organisation the current work is for, in its time
 * zone (I18N-008), so "today" (future-date checks, due and overdue, defaults) agrees between every
 * module and the web app. Outside an organisation, and by default, it is India time.
 */
export function todayIso(): string {
  return businessDate(new Date());
}

/** The business date of a moment in the current organisation's time zone (India by default). */
export function businessDate(at: Date): string {
  return calendarDate(at, currentTimeZone() ?? DEFAULT_BUSINESS_TIME_ZONE);
}

export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Kolkata';

/** The current organisation's time zone (India by default). */
export function orgZone(): string {
  return currentTimeZone() ?? DEFAULT_BUSINESS_TIME_ZONE;
}

/** How a time zone is named next to a date: "India time" for the default. */
export function zoneLabel(tz = orgZone()): string {
  return tz === DEFAULT_BUSINESS_TIME_ZONE ? 'India time' : `${tz} time`;
}

/** The business date (YYYY-MM-DD) of a moment, e.g. when a reminder was sent: in the organisation's time zone. */
export function istDate(at: Date): string {
  return businessDate(at);
}
