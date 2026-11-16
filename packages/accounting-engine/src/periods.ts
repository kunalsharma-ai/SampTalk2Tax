export type PeriodStatus = 'OPEN' | 'LOCKED' | 'CLOSED';

export interface FiscalPeriodSpec {
  fiscalYear: number;
  periodNo: number;
  name: string;
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function assertIsoDate(value: string): void {
  const m = ISO_DATE.exec(value);
  if (!m) throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`Invalid calendar date "${value}"`);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Generate the 12 monthly periods of a fiscal year.
 * `fiscalYear` is labelled by the calendar year in which it ENDS (e.g. an April–March
 * year running 2026-04-01..2027-03-31 is FY2027), matching common practice in India, UK, etc.
 * For January-start years the label equals the calendar year.
 */
export function generateFiscalYear(fiscalYear: number, startMonth: number): FiscalPeriodSpec[] {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) throw new Error('startMonth must be 1..12');
  const startYear = startMonth === 1 ? fiscalYear : fiscalYear - 1;
  const periods: FiscalPeriodSpec[] = [];
  for (let i = 0; i < 12; i++) {
    const month0 = (startMonth - 1 + i) % 12;
    const year = startYear + Math.floor((startMonth - 1 + i) / 12);
    const month1 = month0 + 1;
    periods.push({
      fiscalYear,
      periodNo: i + 1,
      name: `FY${fiscalYear} P${pad(i + 1)} (${MONTHS[month0]} ${year})`,
      startDate: `${year}-${pad(month1)}-01`,
      endDate: `${year}-${pad(month1)}-${pad(lastDayOfMonth(year, month1))}`,
    });
  }
  return periods;
}

/** The fiscal year label that contains a date, given the fiscal year start month. */
export function fiscalYearForDate(date: string, startMonth: number): number {
  assertIsoDate(date);
  const year = +date.slice(0, 4);
  const month = +date.slice(5, 7);
  if (startMonth === 1) return year;
  return month >= startMonth ? year + 1 : year;
}

export function isDateInPeriod(date: string, p: Pick<FiscalPeriodSpec, 'startDate' | 'endDate'>): boolean {
  return date >= p.startDate && date <= p.endDate;
}

/** Whether a journal may be posted into a period with this status. */
export function canPostToPeriod(status: PeriodStatus): boolean {
  return status === 'OPEN';
}
