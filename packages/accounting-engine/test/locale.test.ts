import { describe, expect, it } from 'vitest';
import { checkPreferences, displayDate, displayDateTime, displayMoney, displayNumber, isTimeZone, numberLocale, timeZoneLabel, zonedParts } from '../src';

describe('regional formats', () => {
  it('groups money by the chosen format, with AUTO following the currency, and never rounds', () => {
    expect(displayMoney('1234567.89', 'INR', 'AUTO')).toBe('₹12,34,567.89');
    expect(displayMoney('1234567.89', 'USD', 'AUTO')).toBe('$1,234,567.89');
    expect(displayMoney('1234567.89', 'INR', 'INTL')).toBe('₹1,234,567.89');
    expect(displayMoney('1234567.89', 'EUR', 'EU').replace(/\s/g, ' ')).toBe('1.234.567,89 €');
    expect(displayMoney('-1234567.89', 'INR', 'IN')).toBe('-₹12,34,567.89');
    expect(displayMoney('1234567.89', 'EUR', 'SPACE').replace(/\s/g, ' ')).toBe('1 234 567,89 €');
    // 17 significant digits survive: no binary floating point on the way.
    expect(displayNumber('90071992547409.93', 'USD', 'INTL')).toBe('90,071,992,547,409.93');
    expect(displayNumber('0.123456', 'INR', 'IN')).toBe('0.123456');
    expect(numberLocale('AUTO', 'AED')).toBe('en-US');
    expect(() => displayMoney('1e5', 'INR', 'IN')).toThrow(/Not a decimal/);
  });

  it('writes calendar dates in each format and language without shifting them', () => {
    expect(displayDate('2026-11-06', 'D_MON_Y')).toBe('06 Nov 2026');
    expect(displayDate('2026-11-06', 'DMY')).toBe('06/11/2026');
    expect(displayDate('2026-11-06', 'MDY')).toBe('11/06/2026');
    expect(displayDate('2026-11-06', 'YMD')).toBe('2026-11-06');
    expect(displayDate('2026-03-31', 'D_MON_Y', 'hi')).toBe('31 मार्च 2026');
    expect(() => displayDate('6/11/2026', 'DMY')).toThrow(/Not a date/);
  });

  it('shows a moment in the chosen time zone, across midnight', () => {
    const at = new Date('2026-11-05T21:34:00Z');
    expect(zonedParts(at, 'Asia/Kolkata')).toEqual({ date: '2026-11-06', time: '03:04' });
    expect(displayDateTime(at, { dateFormat: 'D_MON_Y', timeZone: 'Asia/Kolkata', language: 'en' })).toBe('06 Nov 2026, 03:04');
    expect(displayDateTime(at, { dateFormat: 'YMD', timeZone: 'America/New_York', language: 'en' })).toBe('2026-11-05, 16:34');
    expect(displayDateTime('2026-11-05T21:34:00Z', { dateFormat: 'DMY', timeZone: 'UTC', language: 'en' })).toBe('05/11/2026, 21:34');
    expect(timeZoneLabel('Asia/Kolkata', at)).toBe('Asia/Kolkata (UTC+05:30)');
    expect(timeZoneLabel('UTC', at)).toBe('UTC (UTC+00:00)');
  });

  it('accepts real IANA zones only and explains refused preferences', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    for (const bad of ['IST', 'Asia/Atlantis', '', 'Asia/Kolkata; drop', '../etc']) expect(isTimeZone(bad)).toBe(false);
    expect(checkPreferences({ language: 'en', numberFormat: 'IN', dateFormat: 'DMY', timeZone: 'Europe/London' })).toEqual([]);
    expect(checkPreferences({ language: 'fr', numberFormat: 'XX', dateFormat: 'DD', timeZone: 'IST' })).toEqual([
      'Choose a language from the list',
      'Choose a number format from the list',
      'Choose a date format from the list',
      'Choose a time zone such as Asia/Kolkata or Europe/London',
    ]);
  });
});
