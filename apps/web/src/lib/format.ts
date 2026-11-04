/**
 * Formatting for display only. Amounts arrive from the API as exact decimal strings and
 * Intl.NumberFormat formats strings without converting through binary floating point.
 */
const cache = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}|${currency}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    cache.set(key, f);
  }
  return f;
}

export function localeFor(currency: string): string {
  return currency === 'INR' ? 'en-IN' : 'en-US';
}

export function money(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  // Intl accepts decimal strings (ES2023 Intl.NumberFormat v3); the cast keeps older TS lib typings happy.
  return formatter(currency, localeFor(currency)).format(amount as unknown as number);
}

export function plain(amount: string, currency: string): string {
  return new Intl.NumberFormat(localeFor(currency), { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount as unknown as number);
}

export function isNegative(amount: string): boolean {
  return amount.trim().startsWith('-');
}

export function date(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
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

/** A moment as a short date and time in India, e.g. "3 Nov 2026, 14:05". */
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
