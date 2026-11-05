/**
 * Formatting for display only. Amounts arrive from the API as exact decimal strings and
 * Intl.NumberFormat formats strings without converting through binary floating point.
 */
import { DEFAULT_PREFERENCES, displayDate, displayDateTime, displayMoney, displayNumber, numberLocale, type DisplayPreferences } from '@talk2tax/accounting-engine';

/**
 * The display preferences in force: the signed-in person's choices, with the organisation's time
 * zone when they have not chosen one. Set by the I18nProvider and the organisation shell before
 * they render their children, so every formatter below sees the same values during a render.
 */
let current: DisplayPreferences = { ...DEFAULT_PREFERENCES };
let personalTimeZone: string | null = null;
let orgTimeZone: string | null = null;
const effective = () => ({ ...current, timeZone: personalTimeZone ?? orgTimeZone ?? DEFAULT_PREFERENCES.timeZone });

export function setDisplayPreferences(p: Omit<DisplayPreferences, 'timeZone'> & { timeZone: string | null }) {
  current = { ...current, language: p.language, numberFormat: p.numberFormat, dateFormat: p.dateFormat };
  personalTimeZone = p.timeZone;
}
export function setOrganisationTimeZone(tz: string | null) {
  orgTimeZone = tz;
}
export function displayPreferences(): DisplayPreferences {
  return effective();
}

export function localeFor(currency: string): string {
  return numberLocale(current.numberFormat, currency);
}

export function money(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  try {
    return displayMoney(amount, currency, current.numberFormat);
  } catch {
    return amount;
  }
}

export function plain(amount: string, currency: string): string {
  try {
    return displayNumber(amount, currency, current.numberFormat);
  } catch {
    return amount;
  }
}

export function isNegative(amount: string): boolean {
  return amount.trim().startsWith('-');
}

/** A calendar date (YYYY-MM-DD) in the person's date format. */
export function date(iso: string): string {
  try {
    return displayDate(iso.slice(0, 10), current.dateFormat, current.language);
  } catch {
    return iso;
  }
}

/**
 * Today's date in India (YYYY-MM-DD), the calendar the API uses for "today", periods and due
 * dates. Using the browser's own date would leave out today's documents for anyone whose clock is
 * behind India time (between 00:00 and 05:30 IST for a browser on UTC).
 */
export function today(): string {
  return new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** A readable name for a browser's user-agent string. Display only; never used for decisions. */
export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 60);
}

/** A moment as date and 24-hour time in the person's time zone (or the organisation's), e.g. "06 Nov 2026, 03:04". */
export function dateTime(iso: string): string {
  try {
    return displayDateTime(iso, effective());
  } catch {
    return iso;
  }
}
