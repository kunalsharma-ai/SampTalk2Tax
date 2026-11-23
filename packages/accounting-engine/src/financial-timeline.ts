import { D } from './money';
import { addDays, daysBetween } from './documents';

/**
 * Financial timeline (DASH-033): what happened in the books, and what falls due, over a range of
 * days, in buckets of a day, a week or a month. Each bucket carries the cash that came in and
 * went out through cash and bank accounts, the cash balance at its end (none for buckets that are
 * still to come), how many entries of each source were posted, and the deadlines that fall in it.
 * Pure: the caller reads the ledger and the compliance calendar.
 */
export type TimelineBucketSize = 'DAY' | 'WEEK' | 'MONTH';

export interface TimelineEntryInput {
  id: string;
  entryNumber: number | null;
  date: string;
  source: string;
  reference: string | null;
  memo: string | null;
  /** Total debit of the entry, functional currency. */
  amount: string;
  /** Cash and bank lines of the entry: debits are cash in, credits cash out. */
  cashIn: string;
  cashOut: string;
}

export interface TimelineDeadlineInput {
  key: string;
  date: string;
  name: string;
  status: string;
}

export interface TimelineBucket {
  start: string;
  end: string;
  future: boolean;
  cashIn: string;
  cashOut: string;
  net: string;
  /** Cash and bank balance at the end of the bucket; null for buckets that start after today. */
  closingCash: string | null;
  entries: number;
  bySource: { source: string; count: number }[];
  deadlines: number;
}

/** Days for a range up to two months, weeks up to about seven months, months beyond. */
export function timelineBucketSize(from: string, to: string): TimelineBucketSize {
  const days = daysBetween(from, to) + 1; // not money
  return days <= 62 ? 'DAY' : days <= 217 ? 'WEEK' : 'MONTH';
}

/** The first day of the bucket a date falls in: itself, the Monday of its week, or the first of its month. */
export function timelineBucketStart(date: string, size: TimelineBucketSize): string {
  if (size === 'DAY') return date;
  if (size === 'MONTH') return `${date.slice(0, 7)}-01`;
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // not money: 0 Sunday
  return addDays(date, -((dow + 6) % 7)); // not money
}

function bucketEnd(start: string, size: TimelineBucketSize): string {
  if (size === 'DAY') return start;
  if (size === 'WEEK') return addDays(start, 6);
  const [y, m] = start.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // not money
}

export function financialTimeline(input: {
  from: string;
  to: string;
  today: string;
  size?: TimelineBucketSize;
  openingCash: string;
  entries: readonly TimelineEntryInput[];
  deadlines: readonly TimelineDeadlineInput[];
  scale: number;
}) {
  const size = input.size ?? timelineBucketSize(input.from, input.to);
  const starts: string[] = [];
  for (let s = timelineBucketStart(input.from, size); s <= input.to; s = addDays(bucketEnd(s, size), 1)) starts.push(s); // not money
  const index = new Map(starts.map((s, i) => [s, i]));
  const acc = starts.map(() => ({ cashIn: new D(0), cashOut: new D(0), entries: 0, bySource: new Map<string, number>(), deadlines: 0 }));
  const inRange = (d: string) => d >= input.from && d <= input.to;

  const entries = [...input.entries].filter((e) => inRange(e.date)).sort((a, b) => (a.date === b.date ? (a.entryNumber ?? 0) - (b.entryNumber ?? 0) : a.date < b.date ? -1 : 1)); // not money: ordering
  for (const e of entries) {
    const a = acc[index.get(timelineBucketStart(e.date, size))!]!;
    a.cashIn = a.cashIn.plus(e.cashIn);
    a.cashOut = a.cashOut.plus(e.cashOut);
    a.entries += 1;
    a.bySource.set(e.source, (a.bySource.get(e.source) ?? 0) + 1);
  }
  const deadlines = [...input.deadlines].filter((d) => inRange(d.date)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  for (const d of deadlines) acc[index.get(timelineBucketStart(d.date, size))!]!.deadlines += 1;

  let cash = new D(input.openingCash);
  const buckets: TimelineBucket[] = starts.map((start, i) => {
    const a = acc[i]!;
    const future = start > input.today;
    cash = cash.plus(a.cashIn).minus(a.cashOut);
    return {
      start,
      end: bucketEnd(start, size),
      future,
      cashIn: a.cashIn.toFixed(input.scale),
      cashOut: a.cashOut.toFixed(input.scale),
      net: a.cashIn.minus(a.cashOut).toFixed(input.scale),
      closingCash: future ? null : cash.toFixed(input.scale),
      entries: a.entries,
      bySource: [...a.bySource].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([source, count]) => ({ source, count })),
      deadlines: a.deadlines,
    };
  });
  const sources = new Map<string, { count: number; amount: InstanceType<typeof D> }>();
  for (const e of entries) {
    const s = sources.get(e.source) ?? { count: 0, amount: new D(0) };
    s.count += 1;
    s.amount = s.amount.plus(e.amount);
    sources.set(e.source, s);
  }
  const cashIn = entries.reduce((t, e) => t.plus(e.cashIn), new D(0));
  const cashOut = entries.reduce((t, e) => t.plus(e.cashOut), new D(0));
  return {
    from: input.from,
    to: input.to,
    size,
    buckets,
    entries: entries.map((e) => ({ ...e, bucket: timelineBucketStart(e.date, size) })),
    deadlines: deadlines.map((d) => ({ ...d, bucket: timelineBucketStart(d.date, size) })),
    sources: [...sources].sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0])).map(([source, s]) => ({ source, count: s.count, amount: s.amount.toFixed(input.scale) })),
    totals: {
      openingCash: new D(input.openingCash).toFixed(input.scale),
      cashIn: cashIn.toFixed(input.scale),
      cashOut: cashOut.toFixed(input.scale),
      closingCash: new D(input.openingCash).plus(cashIn).minus(cashOut).toFixed(input.scale),
      entries: entries.length,
      deadlines: deadlines.length,
    },
  };
}
