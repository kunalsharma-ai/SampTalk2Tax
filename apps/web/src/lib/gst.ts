import type { GstCategory } from './types';

export const GST_CATEGORY_LABEL: Record<GstCategory, string> = { TAXABLE: 'Taxable', NIL_RATED: 'Nil-rated', EXEMPT: 'Exempt', NON_GST: 'Non-GST' };

/** First and last day of the month containing an ISO date. */
export function monthRange(isoMonth: string): { from: string; to: string } {
  const [y, m] = isoMonth.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${isoMonth}-01`, to: `${isoMonth}-${String(last).padStart(2, '0')}` };
}

/** Return periods are named by month and year, e.g. "October 2026". */
export function monthLabel(isoMonth: string): string {
  const [y, m] = isoMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "₹50,000 a year", "₹50,000 a month" or "none" for a section's thresholds. */
export function thresholdText(s: { singleThreshold: string | null; aggregateThreshold: string | null; thresholdWindow?: 'TAX_YEAR' | 'MONTH'; window?: 'TAX_YEAR' | 'MONTH'; thresholdBasis?: 'WHOLE' | 'EXCESS'; basis?: 'WHOLE' | 'EXCESS' }, fmt: (v: string) => string): string {
  const win = (s.thresholdWindow ?? s.window) === 'MONTH' ? 'a month' : 'a tax year';
  const parts: string[] = [];
  if (s.singleThreshold) parts.push(`above ${fmt(s.singleThreshold)} a document`);
  if (s.aggregateThreshold) parts.push(`${(s.thresholdBasis ?? s.basis) === 'EXCESS' ? 'on the part above' : 'above'} ${fmt(s.aggregateThreshold)} ${win}`);
  return parts.length ? parts.join(', or ') : 'every amount';
}
