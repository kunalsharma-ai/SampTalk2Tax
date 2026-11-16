/**
 * Usage metering (M9 slice 5): what an organisation used in a calendar month and where that
 * stands against its plan's monthly limits. Months run on India time, like every business date.
 */

export type UsageKind = 'AI_CALL' | 'UPLOAD';

/** Shown as a warning from this share of the limit. */
export const USAGE_WARNING_SHARE = 0.8;

export type UsageState = 'UNLIMITED' | 'OK' | 'NEAR' | 'REACHED';

export interface UsageLevel {
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Whole percent of the limit used (can pass 100 when calls already running finish); null when unlimited. */
  percent: number | null;
  state: UsageState;
}

/** Where use stands against a monthly limit. A limit of 0 means none allowed. */
export function usageLevel(used: number, limit: number | null): UsageLevel {
  if (!Number.isInteger(used) || used < 0) throw new RangeError('Usage must be a whole number, zero or more');
  if (limit === null) return { used, limit, remaining: null, percent: null, state: 'UNLIMITED' };
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('A limit must be a whole number, zero or more');
  const remaining = Math.max(0, limit - used);
  const percent = limit === 0 ? 100 : Math.floor((used * 100) / limit);
  const state: UsageState = used >= limit ? 'REACHED' : used >= limit * USAGE_WARNING_SHARE ? 'NEAR' : 'OK';
  return { used, limit, remaining, percent, state };
}

/** Whether one more unit is allowed. */
export function allowsOneMore(used: number, limit: number | null): boolean {
  return limit === null || used < limit;
}

const IST_OFFSET_MS = 330 * 60_000;

/** The India-time calendar month an instant falls in, as YYYY-MM. */
export function usageMonth(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** The instants a month starts and ends (exclusive), India time. */
export function usageMonthRange(month: string): { start: Date; end: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError('A month is written YYYY-MM');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: new Date(`${month}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`) };
}

/** The month and the ones before it, newest first. */
export function recentMonths(month: string, count: number): string[] {
  usageMonthRange(month);
  let [y, m] = month.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}
