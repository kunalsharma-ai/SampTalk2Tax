'use client';
import { chartSeries } from '@talk2tax/design-system';
import { Bar, Brush, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { money } from '@/lib/format';
import { isMotionReduced } from '@/lib/motion';

export type TimelineSize = 'DAY' | 'WEEK' | 'MONTH';
export interface TimelineBucket { start: string; end: string; future: boolean; cashIn: string; cashOut: string; net: string; closingCash: string | null; entries: number; bySource: { source: string; count: number }[]; deadlines: number }
export interface TimelineEntry { id: string; entryNumber: number | null; date: string; source: string; reference: string | null; memo: string | null; amount: string; cashIn: string; cashOut: string; bucket: string }
export interface TimelineDeadline { key: string; date: string; name: string; status: 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'DONE'; bucket: string }
export interface Timeline {
  currency: string;
  today: string;
  complianceConfigured: boolean;
  from: string;
  to: string;
  size: TimelineSize;
  buckets: TimelineBucket[];
  entries: TimelineEntry[];
  deadlines: TimelineDeadline[];
  sources: { source: string; count: number; amount: string }[];
  totals: { openingCash: string; cashIn: string; cashOut: string; closingCash: string; entries: number; deadlines: number };
}

export const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'Manual journals',
  DOCUMENT: 'Invoices and bills',
  PAYMENT: 'Payments',
  BANK: 'Bank',
  EXPENSE: 'Expense claims',
  TAX: 'Tax',
  PAYROLL: 'Payroll',
  ASSET: 'Fixed assets',
  DEFERRAL: 'Deferrals',
  ACCRUAL: 'Accruals',
  LOAN: 'Loans',
  INTERCOMPANY: 'Intercompany',
  FX_REVALUATION: 'Currency revaluation',
  FX_SETTLEMENT: 'Currency settlement',
  BAD_DEBT: 'Bad debts',
  YEAR_END: 'Year end',
  CLOSE: 'Month-end close',
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? s;

const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
/** A bucket's name: 23 Nov, Week of 17 Nov, or Nov 26. */
export const bucketLabel = (b: { start: string }, size: TimelineSize) => (size === 'DAY' ? fmt(b.start, { day: 'numeric', month: 'short' }) : size === 'WEEK' ? `Week of ${fmt(b.start, { day: 'numeric', month: 'short' })}` : fmt(b.start, { month: 'short', year: '2-digit' }));

const reduced = () => isMotionReduced();
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const TIP = { background: 'var(--t2t-surface-raised)', border: '1px solid var(--t2t-border)', borderRadius: 10, fontSize: 12 };

/**
 * Cash in and out per bucket as bars, the cash balance as a line, today and deadlines as markers.
 * Drag the handles under the chart to zoom; choose a bar to see its entries. Floats only place the
 * marks; the tooltip and the tables show the API's strings.
 */
export function TimelineChart({ t, window: [lo, hi], onWindow, onPick, picked }: { t: Timeline; window: [number, number]; onWindow: (w: [number, number]) => void; onPick: (start: string) => void; picked: string | null }) {
  const rows = t.buckets.map((b) => ({ label: bucketLabel(b, t.size), cashIn: Number(b.cashIn), cashOut: -Number(b.cashOut), balance: b.closingCash === null ? null : Number(b.closingCash), b })); // not money: chart geometry
  const todayBucket = t.buckets.find((b) => b.start <= t.today && t.today <= b.end);
  return (
    <div className="h-80 w-full px-2" role="img" aria-label="Cash in, cash out and the cash balance over time, with today and deadlines marked. The same figures are in the table below the chart.">
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} stackOffset="sign" onClick={(s) => { const i = Number(s?.activeIndex ?? s?.activeTooltipIndex); const b = Number.isInteger(i) ? t.buckets[i] : undefined; if (b) onPick(b.start); }}>
          <CartesianGrid stroke="var(--t2t-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={11} minTickGap={12} />
          <YAxis stroke="var(--t2t-text-faint)" tickLine={false} axisLine={false} fontSize={12} tickFormatter={(v) => compact.format(v)} width={56} />
          <Tooltip
            cursor={{ fill: 'rgba(14,165,233,0.08)' }}
            contentStyle={TIP}
            formatter={(_v, name, item) => {
              const b = (item.payload as { b: TimelineBucket }).b;
              const v = name === 'Cash in' ? b.cashIn : name === 'Cash out' ? b.cashOut : (b.closingCash ?? '0');
              return [money(v, t.currency), name];
            }}
            labelFormatter={(label, items) => {
              const b = (items?.[0]?.payload as { b?: TimelineBucket } | undefined)?.b;
              return b ? `${label}: ${b.entries} entr${b.entries === 1 ? 'y' : 'ies'}${b.deadlines ? `, ${b.deadlines} deadline${b.deadlines === 1 ? '' : 's'}` : ''}` : String(label);
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--t2t-text-muted)' }} />
          <ReferenceLine y={0} stroke="var(--t2t-border)" />
          {t.buckets.filter((b) => b.deadlines > 0).map((b) => <ReferenceLine key={`d-${b.start}`} x={bucketLabel(b, t.size)} stroke="#f59e0b" strokeDasharray="2 3" />)}
          {todayBucket ? <ReferenceLine x={bucketLabel(todayBucket, t.size)} stroke="var(--t2t-accent)" label={{ value: 'Today', position: 'insideTopRight', fontSize: 11, fill: 'var(--t2t-accent)' }} /> : null}
          {picked ? <ReferenceLine x={bucketLabel({ start: picked }, t.size)} stroke="var(--t2t-text-muted)" strokeWidth={2} /> : null}
          <Bar dataKey="cashIn" name="Cash in" stackId="c" fill={chartSeries[2]} maxBarSize={24} cursor="pointer" isAnimationActive={!reduced()} />
          <Bar dataKey="cashOut" name="Cash out" stackId="c" fill="#f87171" maxBarSize={24} cursor="pointer" isAnimationActive={!reduced()} />
          <Line dataKey="balance" name="Cash balance" stroke={chartSeries[0]} strokeWidth={2} dot={false} type="linear" connectNulls={false} isAnimationActive={!reduced()} />
          {rows.length > 1 ? <Brush dataKey="label" height={22} travellerWidth={8} stroke="var(--t2t-accent)" fill="var(--t2t-surface)" startIndex={lo} endIndex={hi} onChange={(w) => { if (typeof w.startIndex === 'number' && typeof w.endIndex === 'number') onWindow([w.startIndex, w.endIndex]); }} /> : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
