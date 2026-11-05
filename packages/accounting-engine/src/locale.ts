/**
 * Languages and regional formats. A person chooses the language of the interface and how numbers,
 * dates and times are shown; an organisation has a time zone that moments are shown in. These are
 * display choices only: amounts stay exact decimal strings, dates stay ISO dates, and none of this
 * changes tax or legal behaviour, which follows the organisation's country (see the country
 * modules), never the interface language.
 */

export const LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', dir: 'ltr' },
] as const;
export type Language = (typeof LANGUAGES)[number]['code'];
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as unknown as readonly [Language, ...Language[]];

/**
 * How numbers are grouped and which marks are used. AUTO follows the currency: Indian grouping for
 * INR, international grouping otherwise.
 */
export const NUMBER_FORMATS = [
  { code: 'AUTO', label: 'Follow the currency', example: null, locale: null },
  { code: 'IN', label: 'Indian (lakh and crore)', example: '12,34,567.89', locale: 'en-IN' },
  { code: 'INTL', label: 'International', example: '1,234,567.89', locale: 'en-US' },
  { code: 'EU', label: 'European', example: '1.234.567,89', locale: 'de-DE' },
  { code: 'SPACE', label: 'Spaces', example: '1 234 567,89', locale: 'fr-FR' },
] as const;
export type NumberFormat = (typeof NUMBER_FORMATS)[number]['code'];
export const NUMBER_FORMAT_CODES = NUMBER_FORMATS.map((f) => f.code) as unknown as readonly [NumberFormat, ...NumberFormat[]];

export const DISPLAY_DATE_FORMATS = [
  { code: 'D_MON_Y', label: 'Day, month name, year', example: '06 Nov 2026' },
  { code: 'DMY', label: 'Day/month/year', example: '06/11/2026' },
  { code: 'MDY', label: 'Month/day/year', example: '11/06/2026' },
  { code: 'YMD', label: 'Year-month-day (ISO)', example: '2026-11-06' },
] as const;
export type DisplayDateFormat = (typeof DISPLAY_DATE_FORMATS)[number]['code'];
export const DISPLAY_DATE_FORMAT_CODES = DISPLAY_DATE_FORMATS.map((f) => f.code) as unknown as readonly [DisplayDateFormat, ...DisplayDateFormat[]];

export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

export interface DisplayPreferences {
  language: Language;
  numberFormat: NumberFormat;
  dateFormat: DisplayDateFormat;
  /** IANA time zone moments are shown in. */
  timeZone: string;
}
export const DEFAULT_PREFERENCES: DisplayPreferences = Object.freeze({ language: 'en', numberFormat: 'AUTO', dateFormat: 'D_MON_Y', timeZone: DEFAULT_TIME_ZONE });

/** Whether this runtime knows the IANA time zone (rejects abbreviations such as "IST"). */
export function isTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !/^[A-Za-z]+(?:[/_+-][A-Za-z0-9]+)*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz) || tz.length > 64) return false;
  if (tz !== 'UTC' && !tz.includes('/')) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Common time zones offered in pickers; any valid IANA zone is accepted. */
export const COMMON_TIME_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Africa/Nairobi',
  'Africa/Lagos',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'UTC',
] as const;

/** The Intl locale used for numbers under a format; AUTO picks by currency. */
export function numberLocale(format: NumberFormat, currency: string): string {
  if (format === 'AUTO') return currency === 'INR' ? 'en-IN' : 'en-US';
  return NUMBER_FORMATS.find((f) => f.code === format)!.locale!;
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    nfCache.set(key, f);
  }
  return f;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * An exact decimal string as money in a currency, in the chosen grouping. The string is passed to
 * Intl as a string (Intl.NumberFormat v3), so it is never rounded through binary floating point.
 */
export function displayMoney(amount: string, currency: string, format: NumberFormat): string {
  if (!DECIMAL.test(amount.trim())) throw new Error(`Not a decimal amount: ${amount}`);
  return nf(numberLocale(format, currency), { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).format(amount.trim() as unknown as number);
}

/** An exact decimal string as a plain number with 2 to 6 decimals, in the chosen grouping. */
export function displayNumber(amount: string, currency: string, format: NumberFormat): string {
  if (!DECIMAL.test(amount.trim())) throw new Error(`Not a decimal amount: ${amount}`);
  return nf(numberLocale(format, currency), { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(amount.trim() as unknown as number);
}

const monthCache = new Map<Language, string[]>();
/** Short month names from the runtime's CLDR data (English: Jan; Hindi: जन॰). */
function months(language: Language): string[] {
  let m = monthCache.get(language);
  if (!m) {
    const f = new Intl.DateTimeFormat(language === 'hi' ? 'hi-IN' : 'en-GB', { month: 'short', timeZone: 'UTC' });
    m = Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2026, i, 15))));
    monthCache.set(language, m);
  }
  return m;
}

/** A calendar date (YYYY-MM-DD) in the chosen format. Month names follow the language. Never shifted by a time zone. */
export function displayDate(iso: string, format: DisplayDateFormat, language: Language = 'en'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Not a date: ${iso}`);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  switch (format) {
    case 'D_MON_Y':
      return `${d} ${months(language)[Number(mo) - 1]} ${y}`;
    case 'DMY':
      return `${d}/${mo}/${y}`;
    case 'MDY':
      return `${mo}/${d}/${y}`;
    case 'YMD':
      return `${y}-${mo}-${d}`;
  }
}

/** The calendar date and wall-clock time of a moment in a time zone. */
export function zonedParts(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` };
}

/** A moment as date and 24-hour time in a time zone, e.g. "06 Nov 2026, 03:04". */
export function displayDateTime(at: Date | string, prefs: Pick<DisplayPreferences, 'dateFormat' | 'timeZone' | 'language'>): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new Error(`Not a moment: ${String(at)}`);
  const z = zonedParts(d, prefs.timeZone);
  return `${displayDate(z.date, prefs.dateFormat, prefs.language)}, ${z.time}`;
}

/** A short label for a time zone with its current offset, e.g. "Asia/Kolkata (UTC+05:30)". */
export function timeZoneLabel(tz: string, at = new Date()): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const offset = name === 'GMT' ? 'UTC+00:00' : name.replace('GMT', 'UTC');
  return `${tz} (${offset})`;
}

/** Problems with a set of preferences, in words; empty when they are fine. */
export function checkPreferences(p: Partial<Record<keyof DisplayPreferences, unknown>>): string[] {
  const out: string[] = [];
  if (p.language !== undefined && !(LANGUAGE_CODES as readonly unknown[]).includes(p.language)) out.push('Choose a language from the list');
  if (p.numberFormat !== undefined && !(NUMBER_FORMAT_CODES as readonly unknown[]).includes(p.numberFormat)) out.push('Choose a number format from the list');
  if (p.dateFormat !== undefined && !(DISPLAY_DATE_FORMAT_CODES as readonly unknown[]).includes(p.dateFormat)) out.push('Choose a date format from the list');
  if (p.timeZone !== undefined && p.timeZone !== null && !isTimeZone(String(p.timeZone))) out.push('Choose a time zone such as Asia/Kolkata or Europe/London');
  return out;
}
